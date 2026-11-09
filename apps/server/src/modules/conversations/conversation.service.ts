import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ConversationView,
  Message as MessageView,
  MessagePage,
  ConversationEventView,
  ConversationNoteView,
} from '@smartdesk/shared';
import type {
  Prisma,
  Conversation,
  Message,
  Organization,
  OutboxEvent,
} from '../../generated/prisma/client';
import {
  IdentityService,
  type IdentityRequest,
} from '../identity/identity.service';
import { WidgetService } from '../widget/widget.service';
import { choice, fail, object, text, uuid, version } from '../identity/input';
import {
  ConversationStateService,
  recordOutbox,
  type StateChange,
} from './conversation-state.service';
import { PresenceService } from '../identity/presence.service';

type Tx = Prisma.TransactionClient;
type Actor = {
  organizationId: string;
  id: string;
  type: 'visitor' | 'agent';
  role?: string;
  sessionId?: string;
};
const header = (r: IdentityRequest, key: string) =>
  typeof r.headers[key] === 'string' ? (r.headers[key] as string) : '';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const id = (value: unknown) => uuid(value).toLowerCase();
const messageView = (m: Message): MessageView => ({
  id: m.id,
  conversationId: m.conversationId,
  senderId: m.senderId,
  senderType: m.senderType as MessageView['senderType'],
  clientMessageId: m.clientMessageId,
  seq: m.seq,
  content: m.content,
  createdAt: m.createdAt.toISOString(),
  conversationVersion: m.conversationVersion,
});
const messageInput = (value: unknown) => {
  const b = object(value, ['clientMessageId', 'content']);
  const content = text(b.content, 1, 8000);
  if (
    !content.trim() ||
    content.includes('\0') ||
    /[\uD800-\uDFFF]/u.test(content)
  )
    fail(422, 'INVALID_INPUT', '消息正文无效');
  return { clientMessageId: id(b.clientMessageId), content };
};
function integer(value: unknown, min = 0, max = 2147483647) {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < min ||
    number > max
  )
    return fail(422, 'INVALID_INPUT', '分页或序号无效');
  return number;
}
function query(r: IdentityRequest, allowed: string[]) {
  for (const key of r.query.keys())
    if (!allowed.includes(key) || r.query.getAll(key).length !== 1)
      fail(422, 'INVALID_INPUT', '查询字段不支持或重复');
}
const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string, scope: string, fields: string[]) {
  try {
    if (value.length > 2048) throw new Error('cursor');
    const parsed = object(
      JSON.parse(Buffer.from(value, 'base64url').toString()),
      ['scope', ...fields],
    );
    if (parsed.scope !== scope) throw new Error('scope');
    return parsed;
  } catch {
    return fail(422, 'INVALID_CURSOR', '分页游标不属于当前范围或格式无效');
  }
}

@Injectable()
export class ConversationService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(WidgetService) private readonly widget: WidgetService,
    @Inject(ConversationStateService)
    private readonly states: ConversationStateService,
    @Inject(PresenceService) private readonly presence: PresenceService,
  ) {}

  /** Lock order is organization -> session -> member -> conversation; no remote calls in a transaction. */
  private async transaction<T>(
    r: IdentityRequest,
    create: boolean,
    work: (tx: Tx, actor: Actor, org: Organization) => Promise<T>,
  ): Promise<T> {
    const visitor = r.headers.authorization !== undefined;
    if (visitor && r.headers['x-organization-id'] !== undefined)
      fail(422, 'INVALID_INPUT', '访客企业由凭据确定');
    if (r.method !== 'GET') {
      if (!/^application\/json(?:;|$)/i.test(header(r, 'content-type')))
        fail(403, 'CSRF_REJECTED', '需要 JSON 请求');
      if (
        !visitor &&
        (header(r, 'origin') !== this.identity.origin ||
          header(r, 'x-requested-with') !== 'SmartDesk')
      )
        fail(403, 'CSRF_REJECTED', '请求来源无效');
    }
    if (create && !visitor) fail(403, 'FORBIDDEN', '只有访客可发起会话');
    const initial = visitor
      ? await this.widget.visitor(this.identity.db, r)
      : null;
    const organizationId = initial?.organizationId ?? id(this.identity.org(r));
    return this.identity.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId}::uuid FOR SHARE`;
        const org = await tx.organization.findUnique({
          where: { id: organizationId },
        });
        if (!org) return fail(404, 'NOT_FOUND', '企业不可访问');
        let actor: Actor;
        if (visitor) {
          const session = await this.widget.visitor(
            tx,
            r,
            create ? 'update' : 'share',
          );
          actor = {
            organizationId,
            id: session.customerId,
            type: 'visitor',
            sessionId: session.id,
          };
        } else {
          const m = await this.identity.membership(
            tx,
            r,
            organizationId,
            false,
            true,
          );
          actor = { organizationId, id: m.id, type: 'agent', role: m.role };
        }
        return work(tx, actor, org);
      },
      { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 },
    );
  }
  private acl(actor: Actor): Prisma.ConversationWhereInput {
    return {
      organizationId: actor.organizationId,
      ...(actor.type === 'visitor'
        ? { customerId: actor.id }
        : actor.role === 'admin'
          ? {}
          : {
              OR: [
                { assignedMembershipId: actor.id },
                { status: 'waiting_human', assignedMembershipId: null },
              ],
            }),
    };
  }
  private async conversation(
    tx: Tx,
    actor: Actor,
    conversationId: string,
    write = false,
  ) {
    if (write)
      await tx.$queryRaw`SELECT id FROM conversations WHERE organization_id=${actor.organizationId}::uuid AND id=${conversationId}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM conversations WHERE organization_id=${actor.organizationId}::uuid AND id=${conversationId}::uuid FOR SHARE`;
    const c = await tx.conversation.findFirst({
      where: { ...this.acl(actor), id: conversationId },
    });
    if (!c) return fail(404, 'NOT_FOUND', '会话不可访问');
    return c;
  }
  private async views(
    tx: Tx,
    actor: Actor,
    conversations: Conversation[],
  ): Promise<ConversationView[]> {
    const ids = conversations.map((c) => c.id);
    if (!ids.length) return [];
    const customers = await tx.customer.findMany({
      where: {
        organizationId: actor.organizationId,
        id: { in: conversations.map((c) => c.customerId) },
      },
      select: { id: true, name: true, email: true, preferredLanguage: true },
    });
    const summaries = await tx.$queryRaw<
      { conversation_id: string; summary: string }[]
    >`SELECT DISTINCT ON (conversation_id) conversation_id, left(content,120) AS summary FROM messages WHERE organization_id=${actor.organizationId}::uuid AND conversation_id=ANY(${ids}::uuid[]) ORDER BY conversation_id,seq DESC`;
    const counts =
      actor.type === 'agent'
        ? await tx.$queryRaw<
            { conversation_id: string; unread: number }[]
          >`SELECT m.conversation_id, count(*)::int AS unread FROM messages m LEFT JOIN conversation_reads r ON r.organization_id=m.organization_id AND r.conversation_id=m.conversation_id AND r.membership_id=${actor.id}::uuid WHERE m.organization_id=${actor.organizationId}::uuid AND m.conversation_id=ANY(${ids}::uuid[]) AND m.seq>coalesce(r.last_read_seq,0) AND m.sender_type='visitor' GROUP BY m.conversation_id`
        : [];
    const customerMap = new Map(customers.map((c) => [c.id, c]));
    const assignees = await tx.membership.findMany({
      where: {
        organizationId: actor.organizationId,
        id: {
          in: conversations.flatMap((c) =>
            c.assignedMembershipId ? [c.assignedMembershipId] : [],
          ),
        },
      },
      select: { id: true, user: { select: { displayName: true } } },
    });
    const assigneeNames = new Map(
      assignees.map((m) => [m.id, m.user.displayName]),
    );
    const summaryMap = new Map(
      summaries.map((c) => [c.conversation_id, c.summary]),
    );
    const unreadMap = new Map(counts.map((c) => [c.conversation_id, c.unread]));
    return conversations.map((c) => ({
      id: c.id,
      customer: customerMap.get(c.customerId)!,
      status: c.status as ConversationView['status'],
      assignedMembershipId: c.assignedMembershipId,
      assignedDisplayName: c.assignedMembershipId
        ? (assigneeNames.get(c.assignedMembershipId) ?? null)
        : null,
      version: c.version,
      lastSeq: c.lastSeq,
      lastVisitorSeq: c.lastVisitorSeq,
      lastMessageSummary: summaryMap.get(c.id) ?? null,
      updatedAt: c.updatedAt.toISOString(),
      firstHandoffAt: c.firstHandoffAt?.toISOString() ?? null,
      handoffReason: c.firstHandoffReason,
      closedAt: c.closedAt?.toISOString() ?? null,
      resolution: c.resolution,
      ...(actor.type === 'agent'
        ? { unreadCount: unreadMap.get(c.id) ?? 0 }
        : {}),
    }));
  }
  /** Configuration enables task facts, never a claim that a model or worker has run. */
  private modelId() {
    if (process.env.AI_MODE === 'fake') return 'fake-chat-v1';
    if (
      process.env.AI_MODE === 'openai_compatible' &&
      process.env.AI_BASE_URL &&
      process.env.AI_API_KEY &&
      process.env.AI_EMBEDDING_MODEL_ID &&
      Number(process.env.AI_EMBEDDING_DIMENSIONS) > 0 &&
      Number(process.env.AI_MODEL_CONTEXT_TOKENS) > 0 &&
      Number(process.env.AI_EMBEDDING_CONTEXT_TOKENS) > 0
    )
      return process.env.AI_MODEL_ID || null;
    return null;
  }
  private async reception(tx: Tx, org: Organization) {
    const modelId = org.aiEnabled ? this.modelId() : null;
    if (!modelId) return { modelId: null, reason: 'ai_unavailable' };
    const ready = await tx.knowledgeDocument.count({
      where: {
        organizationId: org.id,
        status: 'enabled',
        deletedAt: null,
        currentVersion: { is: { preparationStatus: 'ready' } },
      },
    });
    return ready
      ? { modelId, reason: null }
      : { modelId: null, reason: 'knowledge_insufficient' };
  }
  private async event(
    tx: Tx,
    org: string,
    aggregateType: string,
    aggregateId: string,
    version: number,
    type: string,
    data: Prisma.InputJsonValue,
    destination = 'socket',
  ) {
    await recordOutbox(
      tx,
      org,
      aggregateType,
      aggregateId,
      version,
      type,
      data,
      destination,
    );
  }
  /** This method only persists a new message; callers perform current authorization and deduplication first. */
  private async append(
    tx: Tx,
    actor: Actor,
    c: Conversation,
    org: Organization,
    input: ReturnType<typeof messageInput>,
    now = new Date(),
  ) {
    const seq = c.lastSeq + 1;
    const version = c.version + 1;
    const m = await tx.message.create({
      data: {
        organizationId: org.id,
        conversationId: c.id,
        senderId: actor.id,
        senderType: actor.type,
        senderCustomerId: actor.type === 'visitor' ? actor.id : null,
        senderMembershipId: actor.type === 'agent' ? actor.id : null,
        ...input,
        contentHash: hash(input.content),
        seq,
        conversationVersion: version,
        createdAt: now,
      },
    });
    let activeAiTaskId = c.activeAiTaskId;
    let handoff: string | null = null;
    if (actor.type === 'visitor') {
      await tx.aiTask.updateMany({
        where: {
          organizationId: org.id,
          conversationId: c.id,
          scope: 'conversation_auto',
          status: { in: ['queued', 'running'] },
        },
        data: {
          status: 'superseded',
          version: { increment: 1 },
          finishedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      activeAiTaskId = null;
      if (c.status === 'ai_active') {
        const reception = await this.reception(tx, org);
        const modelId = reception.modelId;
        handoff = reception.reason;
        // Configuration loss must not discard the visitor's already accepted input.
        if (modelId) {
          const source = await tx.message.findMany({
            where: {
              organizationId: org.id,
              conversationId: c.id,
              seq: { lte: seq },
            },
            orderBy: { seq: 'desc' },
            take: 50,
            select: { id: true },
          });
          const customer = await tx.customer.findUniqueOrThrow({
            where: { id: c.customerId },
            select: { preferredLanguage: true },
          });
          const task = await tx.aiTask.create({
            data: {
              organizationId: org.id,
              conversationId: c.id,
              scope: 'conversation_auto',
              operation: 'answer',
              inputRevision: c.inputRevision + 1,
              sourceThroughSeq: seq,
              inputMessageIds: source.reverse().map((m) => m.id),
              latestVisitorSeq: seq,
              receptionEpoch: c.receptionEpoch,
              knowledgeRevision: org.knowledgeRevision,
              aiConfigRevision: org.aiConfigRevision,
              promptVersion: 'auto-answer-v1',
              modelId,
              targetLanguage: customer.preferredLanguage,
              deadlineAt: new Date(now.getTime() + 30000),
            },
          });
          activeAiTaskId = task.id;
          await this.event(
            tx,
            org.id,
            'ai_task',
            task.id,
            task.version,
            'ai.task.requested',
            { taskId: task.id },
            'queue',
          );
        }
      }
    }
    let updated = await tx.conversation.update({
      where: { id: c.id },
      data: {
        version,
        lastSeq: seq,
        updatedAt: now,
        ...(actor.type === 'visitor'
          ? {
              lastVisitorSeq: seq,
              inputRevision: { increment: 1 },
              activeAiTaskId,
            }
          : !c.firstHumanReplyAt
            ? { firstHumanReplyAt: now, firstHumanReplyMembershipId: actor.id }
            : {}),
      },
    });
    if (handoff)
      updated = await this.states.transition(tx, updated, {
        type: 'handoff',
        status: 'waiting_human',
        assignee: null,
        actorType: 'system',
        actorId: org.systemSenderId,
        commandId: randomUUID(),
        handoffReason: handoff,
      });
    const view = messageView(m);
    await this.event(tx, org.id, 'message', m.id, version, 'message.created', {
      ...view,
    });
    if (!handoff)
      await this.event(
        tx,
        org.id,
        'conversation',
        c.id,
        version,
        'conversation.updated',
        {
          id: c.id,
          version,
          status: updated.status,
          lastSeq: seq,
          lastVisitorSeq: updated.lastVisitorSeq,
          assignedMembershipId: updated.assignedMembershipId,
          updatedAt: now.toISOString(),
        },
      );
    return { conversation: updated, message: view };
  }
  async command(r: IdentityRequest, conversationId: string, action: string) {
    query(r, []);
    conversationId = id(conversationId);
    const type = choice(action, [
      'handoff',
      'claim',
      'assign',
      'transfer',
      'close',
      'reopen',
    ]) as StateChange['type'];
    const fields =
      type === 'handoff'
        ? ['reason']
        : type === 'claim'
          ? ['expectedVersion']
          : type === 'assign' || type === 'transfer'
            ? ['expectedVersion', 'membershipId', 'reason']
            : type === 'close'
              ? ['expectedVersion', 'resolution', 'reason']
              : ['expectedVersion', 'reason'];
    const b = object(r.body, fields);
    const expected = type === 'handoff' ? null : version(b.expectedVersion);
    const target = ['assign', 'transfer'].includes(type)
      ? id(b.membershipId)
      : null;
    const reason =
      b.reason === undefined ? undefined : text(b.reason, 1, 1000).trim();
    if (
      (b.reason !== undefined && !reason) ||
      (['transfer', 'reopen'].includes(type) && !reason)
    )
      fail(422, 'INVALID_INPUT', '请填写操作原因');
    if (type === 'handoff') choice(b.reason, ['customer_request']);
    const resolution =
      type === 'close'
        ? choice(b.resolution, [
            'customer_confirmed',
            'agent_resolved',
            'unconfirmed',
          ])
        : undefined;
    const commandId = id(header(r, 'idempotency-key'));
    const digest = hash(
      JSON.stringify({
        conversationId,
        type,
        expected,
        target,
        reason,
        resolution,
      }),
    );
    return this.transaction(r, false, async (tx, actor) => {
      if (
        (type === 'handoff') !== (actor.type === 'visitor') &&
        type !== 'close'
      )
        fail(403, 'FORBIDDEN', '当前身份不能执行此操作');
      if (type === 'assign' && actor.role !== 'admin')
        fail(403, 'FORBIDDEN', '需要管理员权限');
      const key = {
        actorScope: `${actor.type}:${actor.organizationId}:${actor.id}`,
        operation: `conversation.${type}`,
        commandId,
      };
      // Serialize an actor's command across targets, before any conversation lock.
      const lockKey = `${key.actorScope}:${key.operation}:${commandId}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey},0))::text`;
      if (target)
        await tx.$queryRaw`SELECT id FROM memberships WHERE organization_id=${actor.organizationId}::uuid AND id=${target}::uuid FOR SHARE`;
      let c: Conversation;
      if (type === 'claim') {
        await tx.$queryRaw`SELECT id FROM conversations WHERE organization_id=${actor.organizationId}::uuid AND id=${conversationId}::uuid FOR UPDATE`;
        const found = await tx.conversation.findFirst({
          where: { organizationId: actor.organizationId, id: conversationId },
        });
        if (!found) return fail(404, 'NOT_FOUND', '会话不可访问');
        c = found;
      } else c = await this.conversation(tx, actor, conversationId, true);
      const receipt = await tx.operationReceipt.findUnique({
        where: { actorScope_operation_commandId: key },
      });
      if (receipt) {
        if (receipt.requestHash !== digest)
          fail(
            409,
            'IDEMPOTENCY_CONFLICT',
            '同一请求标识不能用于不同内容或会话',
          );
        // Even a successful historical command cannot restore lost reading permission.
        c = await this.conversation(tx, actor, conversationId, true);
        return { data: (await this.views(tx, actor, [c]))[0]! };
      }
      if (type === 'handoff' && c.status === 'closed')
        fail(409, 'CONVERSATION_CLOSED', '会话已结束');
      if (
        type === 'claim' &&
        (c.status !== 'waiting_human' || c.assignedMembershipId)
      )
        fail(409, 'ALREADY_ASSIGNED', '会话已被认领或不在等待队列');
      if (expected !== null && c.version !== expected)
        fail(409, 'VERSION_CONFLICT', '会话已更新，请刷新');
      if (type === 'reopen') {
        if (c.status !== 'closed')
          fail(409, 'STATE_CONFLICT', '只有已结束会话可以重开');
      } else if (c.status === 'closed')
        fail(409, 'CONVERSATION_CLOSED', '会话已结束');
      if (
        ['transfer', 'close', 'reopen'].includes(type) &&
        actor.type === 'agent' &&
        actor.role !== 'admin' &&
        c.assignedMembershipId !== actor.id
      )
        fail(403, 'NOT_ASSIGNEE', '需要会话负责人或管理员权限');
      if (type === 'transfer' && c.status !== 'human_active')
        fail(409, 'STATE_CONFLICT', '仅人工会话可以转交');
      if (type === 'transfer' && target === c.assignedMembershipId)
        fail(409, 'STATE_CONFLICT', '请选择其他接待成员');
      if (
        type === 'close' &&
        resolution !== 'unconfirmed' &&
        resolution !==
          (actor.type === 'visitor' ? 'customer_confirmed' : 'agent_resolved')
      )
        fail(403, 'FORBIDDEN', '结束结果不属于当前身份');
      const assignee =
        type === 'claim' || type === 'reopen' ? actor.id : target;
      if (
        ['claim', 'assign', 'transfer'].includes(type) &&
        !(await this.presence.available(tx, actor.organizationId, assignee!))
      )
        fail(409, 'MEMBER_UNAVAILABLE', '目标成员当前不可接待');
      if (!(type === 'handoff' && c.status !== 'ai_active')) {
        c = await this.states.transition(tx, c, {
          type,
          status:
            type === 'handoff'
              ? 'waiting_human'
              : type === 'close'
                ? 'closed'
                : 'human_active',
          assignee: type === 'close' ? c.assignedMembershipId : assignee,
          actorType: actor.type,
          actorId: actor.id,
          commandId,
          reason,
          resolution,
          handoffReason:
            type === 'handoff' ? 'customer_request' : 'human_takeover',
        });
      }
      await tx.operationReceipt.create({
        data: {
          ...key,
          organizationId: actor.organizationId,
          requestHash: digest,
          responseRef: { conversationId },
        },
      });
      return { data: (await this.views(tx, actor, [c]))[0]! };
    });
  }
  async markRead(r: IdentityRequest, conversationId: string) {
    query(r, []);
    const b = object(r.body, ['lastReadSeq']),
      seq = integer(b.lastReadSeq);
    return this.transaction(r, false, async (tx, actor) => {
      if (actor.type !== 'agent')
        fail(403, 'FORBIDDEN', '访客不支持成员已读游标');
      const c = await this.conversation(tx, actor, id(conversationId));
      if (seq > c.lastSeq) fail(422, 'INVALID_INPUT', '已读序号超过已保存消息');
      const rows = await tx.$queryRaw<
        { last_read_seq: number }[]
      >`INSERT INTO conversation_reads (organization_id,conversation_id,membership_id,last_read_seq,updated_at) VALUES (${actor.organizationId}::uuid,${c.id}::uuid,${actor.id}::uuid,${seq},now()) ON CONFLICT (organization_id,conversation_id,membership_id) DO UPDATE SET last_read_seq=greatest(conversation_reads.last_read_seq,EXCLUDED.last_read_seq),updated_at=now() RETURNING last_read_seq`;
      return { data: { lastReadSeq: rows[0]!.last_read_seq } };
    });
  }
  async events(r: IdentityRequest, conversationId: string) {
    query(r, ['cursor', 'limit']);
    const limit = integer(r.query.get('limit') ?? '20', 1, 100);
    return this.transaction(r, false, async (tx, actor) => {
      if (actor.type !== 'agent')
        fail(403, 'FORBIDDEN', '访客不能读取内部事件');
      const c = await this.conversation(tx, actor, id(conversationId));
      const scope = `events:${actor.organizationId}:${actor.id}:${c.id}`;
      const cursor = r.query.get('cursor');
      const after = cursor ? decode(cursor, scope, ['version', 'id']) : null;
      const rows = await tx.conversationEvent.findMany({
        where: {
          organizationId: actor.organizationId,
          conversationId: c.id,
          ...(after
            ? {
                OR: [
                  { version: { gt: integer(after.version) } },
                  { version: integer(after.version), id: { gt: id(after.id) } },
                ],
              }
            : {}),
        },
        orderBy: [{ version: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      });
      const items: ConversationEventView[] = rows.slice(0, limit).map((e) => ({
        id: e.id,
        type: e.type,
        actorType: e.actorType,
        actorId: e.actorId,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        fromAssignee: e.fromAssignee,
        toAssignee: e.toAssignee,
        reason: e.reason,
        version: e.version,
        createdAt: e.createdAt.toISOString(),
      }));
      const last = items.at(-1);
      return {
        data: {
          items,
          nextCursor:
            rows.length > limit && last
              ? encode({ scope, version: last.version, id: last.id })
              : null,
        },
      };
    });
  }
  async notes(r: IdentityRequest, conversationId: string) {
    const writing = r.method === 'POST';
    query(r, writing ? [] : ['cursor', 'limit']);
    conversationId = id(conversationId);
    return this.transaction(r, false, async (tx, actor) => {
      if (actor.type !== 'agent')
        fail(403, 'FORBIDDEN', '内部备注仅供团队使用');
      const c = await this.conversation(tx, actor, conversationId, writing);
      const view = (note: {
        id: string;
        conversationId: string;
        authorMembershipId: string;
        clientNoteId: string;
        content: string;
        createdAt: Date;
      }): ConversationNoteView => ({
        ...note,
        createdAt: note.createdAt.toISOString(),
      });
      const select = {
        id: true,
        conversationId: true,
        authorMembershipId: true,
        clientNoteId: true,
        content: true,
        createdAt: true,
      } as const;
      if (writing) {
        if (actor.role !== 'admin' && c.assignedMembershipId !== actor.id)
          fail(403, 'NOT_ASSIGNEE', '只有负责人或管理员可添加备注');
        const b = object(r.body, ['clientNoteId', 'content']);
        const input = messageInput({
          clientMessageId: b.clientNoteId,
          content: b.content,
        });
        const key = {
          organizationId: actor.organizationId,
          conversationId,
          authorMembershipId: actor.id,
          clientNoteId: input.clientMessageId,
        };
        const previous = await tx.conversationNote.findUnique({
          where: {
            organizationId_conversationId_authorMembershipId_clientNoteId: key,
          },
          select,
        });
        if (previous) {
          if (previous.content !== input.content)
            fail(409, 'IDEMPOTENCY_CONFLICT', '同一备注标识不能用于不同正文');
          return { status: 200, data: view(previous) };
        }
        if (c.status === 'closed')
          fail(409, 'CONVERSATION_CLOSED', '已关闭会话的备注只读');
        const note = await tx.conversationNote.create({
          data: { ...key, content: input.content },
          select,
        });
        return { status: 201, data: view(note) };
      }
      const scope = `notes:${actor.organizationId}:${actor.id}:${conversationId}`;
      const limit = integer(r.query.get('limit') ?? '50', 1, 100);
      const cursor = r.query.get('cursor');
      let before: Prisma.ConversationNoteWhereInput = {};
      if (cursor) {
        const decoded = decode(cursor, scope, ['createdAt', 'id']);
        const date = new Date(text(decoded.createdAt, 1, 40));
        if (Number.isNaN(date.getTime()))
          fail(422, 'INVALID_CURSOR', '备注游标无效');
        before = {
          OR: [
            { createdAt: { lt: date } },
            { createdAt: date, id: { lt: id(decoded.id) } },
          ],
        };
      }
      const rows = await tx.conversationNote.findMany({
        where: {
          organizationId: actor.organizationId,
          conversationId,
          ...before,
        },
        select,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const items = rows.slice(0, limit).map(view),
        last = items.at(-1);
      return {
        data: {
          items,
          nextCursor:
            rows.length > limit && last
              ? encode({ scope, createdAt: last.createdAt, id: last.id })
              : null,
        },
      };
    });
  }
  async create(r: IdentityRequest) {
    query(r, []);
    const b = object(r.body, ['clientConversationId', 'firstMessage']);
    const clientConversationId = id(b.clientConversationId);
    const input = messageInput(b.firstMessage);
    const commandId = id(header(r, 'idempotency-key'));
    const requestHash = hash(
      JSON.stringify({ clientConversationId, ...input }),
    );
    return this.transaction(r, true, async (tx, actor, org) => {
      const key = {
        actorScope: `visitor:${org.id}:${actor.sessionId}`,
        operation: 'conversation.create',
        commandId,
      };
      const receipt = await tx.operationReceipt.findUnique({
        where: { actorScope_operation_commandId: key },
      });
      if (receipt && receipt.requestHash !== requestHash)
        fail(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同内容');
      let c = await tx.conversation.findUnique({
        where: {
          organizationId_createdByVisitorSessionId_clientConversationId: {
            organizationId: org.id,
            createdByVisitorSessionId: actor.sessionId!,
            clientConversationId,
          },
        },
      });
      let message: MessageView;
      const existing = Boolean(c);
      if (c) {
        c = await this.conversation(tx, actor, c.id, true);
        const first = await tx.message.findFirstOrThrow({
          where: { organizationId: org.id, conversationId: c.id, seq: 1 },
        });
        if (
          first.senderId !== actor.id ||
          first.clientMessageId !== input.clientMessageId ||
          first.content !== input.content
        )
          fail(409, 'IDEMPOTENCY_CONFLICT', '会话创建标识已用于其他首消息');
        message = messageView(first);
      } else {
        const now = new Date();
        const reception = await this.reception(tx, org);
        c = await tx.conversation.create({
          data: {
            organizationId: org.id,
            customerId: actor.id,
            createdByVisitorSessionId: actor.sessionId!,
            clientConversationId,
            status: reception.modelId ? 'ai_active' : 'waiting_human',
            enteredAiAt: reception.modelId ? now : null,
            firstHandoffAt: reception.modelId ? null : now,
            firstHandoffReason: reception.reason,
            createdAt: now,
            updatedAt: now,
          },
        });
        const result = await this.append(tx, actor, c, org, input, now);
        c = result.conversation;
        message = result.message;
      }
      if (!receipt)
        await tx.operationReceipt.create({
          data: {
            ...key,
            organizationId: org.id,
            requestHash,
            responseRef: { conversationId: c.id, messageId: message.id },
          },
        });
      return {
        status: existing ? 200 : 201,
        data: { conversation: (await this.views(tx, actor, [c]))[0]!, message },
      };
    });
  }
  async send(r: IdentityRequest, conversationId: string) {
    query(r, []);
    conversationId = id(conversationId);
    const input = messageInput(r.body);
    return this.transaction(r, false, async (tx, actor, org) => {
      const c = await this.conversation(tx, actor, conversationId, true);
      const previous = await tx.message.findUnique({
        where: {
          organizationId_conversationId_senderId_clientMessageId: {
            organizationId: org.id,
            conversationId,
            senderId: actor.id,
            clientMessageId: input.clientMessageId,
          },
        },
      });
      /** Successful retries remain readable after closure, but never bypass current ACL. */
      if (previous) {
        if (previous.content !== input.content)
          fail(409, 'IDEMPOTENCY_CONFLICT', '同一消息标识不能用于不同正文');
        return { status: 200, data: messageView(previous) };
      }
      if (c.status === 'closed') fail(409, 'CONVERSATION_CLOSED', '会话已结束');
      if (
        actor.type === 'agent' &&
        (c.status !== 'human_active' || c.assignedMembershipId !== actor.id)
      )
        fail(403, 'NOT_ASSIGNEE', '请先接管会话再回复');
      const result = await this.append(tx, actor, c, org, input);
      return { status: 201, data: result.message };
    });
  }
  async requestResult(
    r: IdentityRequest,
    conversationId: string,
    clientMessageId: string,
  ) {
    query(r, []);
    conversationId = id(conversationId);
    clientMessageId = id(clientMessageId);
    return this.transaction(r, false, async (tx, actor) => {
      await this.conversation(tx, actor, conversationId);
      const m = await tx.message.findUnique({
        where: {
          organizationId_conversationId_senderId_clientMessageId: {
            organizationId: actor.organizationId,
            conversationId,
            senderId: actor.id,
            clientMessageId,
          },
        },
      });
      if (!m) return fail(404, 'REQUEST_NOT_FOUND', '尚未找到已保存的请求结果');
      return { data: messageView(m) };
    });
  }
  async detail(r: IdentityRequest, conversationId: string) {
    query(r, []);
    conversationId = id(conversationId);
    return this.transaction(r, false, async (tx, actor) => ({
      data: (
        await this.views(tx, actor, [
          await this.conversation(tx, actor, conversationId),
        ])
      )[0]!,
    }));
  }
  /** Socket handshakes and revocation checks use the same live identity boundary as HTTP. */
  async realtimeIdentity(r: IdentityRequest) {
    return this.transaction(r, false, async (_tx, actor) => actor);
  }
  async subscribe(r: IdentityRequest, conversationId: string) {
    return this.transaction(r, false, async (tx, actor) => {
      const c = await this.conversation(tx, actor, id(conversationId));
      return { conversationVersion: c.version, snapshotThroughSeq: c.lastSeq };
    });
  }
  /** Never broadcast stored payload wholesale: current authorization and allowlisted projections are authoritative. */
  async realtimeEvent(
    r: IdentityRequest,
    event: OutboxEvent,
    subscriptions: Set<string>,
  ) {
    return this.transaction(r, false, async (tx, actor) => {
      if (actor.organizationId !== event.organizationId) return null;
      let data: unknown;
      if (event.eventType === 'message.created') {
        const m = await tx.message.findFirst({
          where: {
            organizationId: actor.organizationId,
            id: event.aggregateId,
          },
        });
        if (!m || !subscriptions.has(m.conversationId)) return null;
        await this.conversation(tx, actor, m.conversationId);
        data = messageView(m);
      } else if (event.eventType === 'conversation.updated') {
        if (!subscriptions.has(event.aggregateId)) return null;
        const c = await this.conversation(tx, actor, event.aggregateId);
        data = {
          id: c.id,
          version: c.version,
          status: c.status,
          lastSeq: c.lastSeq,
          updatedAt: c.updatedAt.toISOString(),
          ...(actor.type === 'agent'
            ? {
                assignedMembershipId: c.assignedMembershipId,
                lastVisitorSeq: c.lastVisitorSeq,
              }
            : {}),
        };
      } else {
        if (actor.type !== 'agent') return null;
        const where = {
          organizationId: actor.organizationId,
          id: event.aggregateId,
        };
        // Presence invalidations have their own event identity; only the referenced member is projected live.
        if (
          event.eventType === 'presence.updated' &&
          event.aggregateType === 'presence'
        ) {
          const envelope = object(event.payload, [
            'eventId',
            'type',
            'occurredAt',
            'data',
          ]);
          where.id = id(object(envelope.data, ['membershipId']).membershipId);
        }
        if (event.eventType === 'ticket.updated') {
          const t = await tx.ticket.findFirst({
            where: {
              ...where,
              ...(actor.role === 'admin'
                ? {}
                : { ownerMembershipId: actor.id }),
            },
          });
          if (!t) return null;
          data = { id: t.id, version: t.version };
        } else if (event.eventType === 'ai.task.updated') {
          const t = await tx.aiTask.findFirst({ where });
          if (!t) return null;
          if (t.conversationId)
            await this.conversation(tx, actor, t.conversationId);
          else if (
            actor.role !== 'admin' ||
            t.requestedByMembershipId !== actor.id
          )
            return null;
          data = {
            taskId: t.id,
            status: t.status,
            inputRevision: t.inputRevision,
            version: t.version,
          };
        } else if (event.eventType === 'knowledge.updated') {
          const d = await tx.knowledgeDocument.findFirst({
            where,
            include: { currentVersion: true },
          });
          if (
            !d ||
            (actor.role !== 'admin' &&
              (d.status !== 'enabled' ||
                d.deletedAt ||
                d.currentVersion?.preparationStatus !== 'ready'))
          )
            return null;
          data = {
            id: d.id,
            version: d.version,
            preparationStatus:
              d.currentVersion?.preparationStatus === 'pending'
                ? 'not_started'
                : (d.currentVersion?.preparationStatus ?? null),
          };
        } else if (
          event.eventType === 'membership.updated' ||
          event.eventType === 'presence.updated'
        ) {
          const m = await tx.membership.findFirst({ where });
          if (!m) return null;
          if (event.eventType === 'membership.updated')
            data = { id: m.id, version: m.version };
          else {
            data = {
              id: m.id,
              online: await this.presence.available(
                tx,
                actor.organizationId,
                m.id,
              ),
            };
          }
        } else throw new Error('UNSUPPORTED_EVENT');
      }
      return {
        eventId: event.id,
        type: event.eventType,
        occurredAt: event.createdAt.toISOString(),
        data,
      };
    });
  }
  async list(r: IdentityRequest) {
    query(r, ['status', 'view', 'cursor', 'limit']);
    const limit = integer(r.query.get('limit') ?? '20', 1, 100);
    const status = r.query.has('status')
      ? choice(r.query.get('status'), [
          'ai_active',
          'waiting_human',
          'human_active',
          'closed',
        ])
      : undefined;
    const view = r.query.has('view')
      ? choice(r.query.get('view'), ['waiting', 'mine', 'all'])
      : 'all';
    return this.transaction(r, false, async (tx, actor) => {
      if (actor.type === 'visitor' && r.query.has('view'))
        fail(422, 'INVALID_INPUT', '访客不支持成员视图');
      const scope = `conversations:${actor.organizationId}:${actor.type}:${actor.id}:${view}:${status ?? ''}`;
      const cursor = r.query.get('cursor');
      let boundary: Prisma.ConversationWhereInput = {};
      if (cursor) {
        const p = decode(cursor, scope, ['at', 'id']);
        const at = new Date(text(p.at, 1, 40));
        if (!Number.isFinite(at.getTime()))
          fail(422, 'INVALID_CURSOR', '游标时间无效');
        const cursorId = id(p.id);
        boundary = {
          OR: [
            { createdAt: { lt: at } },
            { createdAt: at, id: { lt: cursorId } },
          ],
        };
      }
      const where: Prisma.ConversationWhereInput = {
        AND: [
          this.acl(actor),
          status ? { status } : {},
          view === 'mine'
            ? { assignedMembershipId: actor.id }
            : view === 'waiting'
              ? { status: 'waiting_human', assignedMembershipId: null }
              : {},
          boundary,
        ],
      };
      const rows = await tx.conversation.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      // Lock in ID order, then re-authorize: assignment may have changed since list selection.
      const selected = rows.slice(0, limit);
      const selectedIds = selected.map((c) => c.id);
      if (selectedIds.length)
        await tx.$queryRaw`SELECT id FROM conversations WHERE organization_id=${actor.organizationId}::uuid AND id=ANY(${selectedIds}::uuid[]) ORDER BY id FOR SHARE`;
      const locked = await tx.conversation.findMany({
        where: { AND: [where, { id: { in: selectedIds } }] },
      });
      const map = new Map(locked.map((c) => [c.id, c]));
      const last = selected.at(-1);
      return {
        data: {
          items: await this.views(
            tx,
            actor,
            selected.flatMap((c) => (map.has(c.id) ? [map.get(c.id)!] : [])),
          ),
          nextCursor:
            rows.length > limit && last
              ? encode({ scope, at: last.createdAt.toISOString(), id: last.id })
              : null,
        },
      };
    });
  }
  async history(r: IdentityRequest, conversationId: string) {
    query(r, ['afterSeq', 'beforeSeq', 'cursor', 'throughSeq', 'limit']);
    conversationId = id(conversationId);
    const modes = ['afterSeq', 'beforeSeq', 'cursor'].filter((k) =>
      r.query.has(k),
    );
    if (
      modes.length > 1 ||
      (r.query.has('cursor') && r.query.has('throughSeq'))
    )
      fail(422, 'INVALID_INPUT', '补拉模式互斥');
    const limit = integer(r.query.get('limit') ?? '50', 1, 100);
    return this.transaction(r, false, async (tx, actor) => {
      const c = await this.conversation(tx, actor, conversationId);
      const scope = `messages:${actor.organizationId}:${conversationId}:${actor.type}:${actor.id}`;
      let mode: MessagePage['mode'] = r.query.has('afterSeq')
        ? 'after'
        : r.query.has('beforeSeq')
          ? 'before'
          : 'latest';
      let through = integer(r.query.get('throughSeq') ?? c.lastSeq);
      let position = integer(
        r.query.get('afterSeq') ?? r.query.get('beforeSeq') ?? 0,
      );
      if (r.query.has('cursor')) {
        const p = decode(r.query.get('cursor')!, scope, [
          'mode',
          'through',
          'position',
        ]);
        mode = choice(p.mode, ['before', 'after']) as MessagePage['mode'];
        through = integer(p.through);
        position = integer(p.position);
      }
      if (
        through > c.lastSeq ||
        (mode === 'after' && position > through) ||
        (mode === 'before' && (position < 1 || position > c.lastSeq + 1))
      )
        fail(422, 'INVALID_INPUT', '序号超过历史水位');
      const rows = await tx.message.findMany({
        where: {
          organizationId: actor.organizationId,
          conversationId,
          seq: {
            lte: through,
            ...(mode === 'after'
              ? { gt: position }
              : mode === 'before'
                ? { lt: position }
                : {}),
          },
        },
        orderBy: { seq: mode === 'after' ? 'asc' : 'desc' },
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const selected = rows.slice(0, limit);
      if (mode !== 'after') selected.reverse();
      const next = mode === 'after' ? selected.at(-1)?.seq : selected[0]?.seq;
      const data: MessagePage = {
        items: selected.map(messageView),
        mode,
        snapshotThroughSeq: through,
        windowStartSeq: selected[0]?.seq ?? null,
        hasMore,
        nextCursor: hasMore
          ? encode({
              scope,
              mode: mode === 'after' ? 'after' : 'before',
              through,
              position: next,
            })
          : null,
      };
      return { data };
    });
  }
}
