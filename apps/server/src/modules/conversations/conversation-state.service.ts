import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Conversation, Prisma } from '../../generated/prisma/client';
import type { ConversationStatus } from '@smartdesk/shared';
import { fail } from '../identity/input';

type Tx = Prisma.TransactionClient;
export async function recordOutbox(
  tx: Tx,
  organizationId: string,
  aggregateType: string,
  aggregateId: string,
  aggregateVersion: number,
  eventType: string,
  data: Prisma.InputJsonValue,
  destination = 'socket',
) {
  const id = randomUUID();
  await tx.outboxEvent.create({
    data: {
      id,
      organizationId,
      aggregateType,
      aggregateId,
      aggregateVersion,
      eventType,
      destination,
      payload: {
        eventId: id,
        type: eventType,
        occurredAt: new Date().toISOString(),
        data,
      },
    },
  });
}
export type StateChange = {
  type: 'handoff' | 'claim' | 'assign' | 'transfer' | 'close' | 'reopen';
  status: ConversationStatus;
  assignee: string | null;
  actorType: 'visitor' | 'agent' | 'system';
  actorId: string;
  commandId: string;
  reason?: string;
  handoffReason?: string;
  resolution?: string;
};

@Injectable()
export class ConversationStateService {
  /** Caller holds organization then conversation locks. No external IO or ticket writes. */
  async transition(tx: Tx, c: Conversation, change: StateChange) {
    const now = new Date();
    const firstHandoff =
      !c.firstHandoffAt &&
      ['waiting_human', 'human_active'].includes(change.status);
    const changed = await tx.conversation.updateMany({
      where: {
        organizationId: c.organizationId,
        id: c.id,
        version: c.version,
        ...(change.type === 'claim'
          ? { status: 'waiting_human', assignedMembershipId: null }
          : {}),
      },
      data: {
        status: change.status,
        assignedMembershipId: change.assignee,
        version: { increment: 1 },
        receptionEpoch: { increment: 1 },
        activeAiTaskId: null,
        clarificationPending: false,
        updatedAt: now,
        ...(firstHandoff
          ? {
              firstHandoffAt: now,
              firstHandoffReason: change.handoffReason ?? 'human_takeover',
            }
          : {}),
        ...(change.type === 'close'
          ? { closedAt: now, resolution: change.resolution }
          : {}),
        ...(change.type === 'reopen'
          ? { closedAt: null, resolution: null }
          : {}),
      },
    });
    if (changed.count !== 1)
      fail(409, 'VERSION_CONFLICT', '会话已更新，请刷新');
    // Terminal AI history remains intact; old automatic candidates lose both epoch and lease.
    await tx.aiTask.updateMany({
      where: {
        organizationId: c.organizationId,
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
    const next = await tx.conversation.findUniqueOrThrow({
      where: { id: c.id },
    });
    await tx.conversationEvent.create({
      data: {
        organizationId: c.organizationId,
        conversationId: c.id,
        type: change.type,
        actorType: change.actorType,
        actorId: change.actorId,
        commandId: change.commandId,
        fromStatus: c.status,
        toStatus: next.status,
        fromAssignee: c.assignedMembershipId,
        toAssignee: next.assignedMembershipId,
        reason: change.reason ?? change.handoffReason,
        version: next.version,
        createdAt: now,
      },
    });
    await recordOutbox(
      tx,
      c.organizationId,
      'conversation',
      c.id,
      next.version,
      'conversation.updated',
      { id: c.id, version: next.version },
    );
    return next;
  }
  /** Management already holds an exclusive organization lock; lock the affected set in ID order. */
  async compensate(
    tx: Tx,
    organizationId: string,
    actorId: string,
    commandId: string,
    membershipId?: string,
  ) {
    const rows = membershipId
      ? await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM conversations WHERE organization_id=${organizationId}::uuid AND status='human_active' AND assigned_membership_id=${membershipId}::uuid ORDER BY id FOR UPDATE`
      : await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM conversations WHERE organization_id=${organizationId}::uuid AND status='ai_active' ORDER BY id FOR UPDATE`;
    for (const { id } of rows) {
      const c = await tx.conversation.findUniqueOrThrow({ where: { id } });
      await this.transition(tx, c, {
        type: 'handoff',
        status: 'waiting_human',
        assignee: null,
        actorType: 'agent',
        actorId,
        commandId,
        reason: membershipId ? 'membership_disabled' : 'ai_unavailable',
        handoffReason: membershipId ? 'human_takeover' : 'ai_unavailable',
      });
    }
  }
}
