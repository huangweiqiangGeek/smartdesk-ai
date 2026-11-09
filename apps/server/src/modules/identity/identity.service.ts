import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../../generated/prisma/client';
import { settings } from '../../config';
import {
  ApiError,
  choice,
  fail,
  object,
  text,
  timezone,
  uuid,
  version,
} from './input';
import { memberSelect, PresenceService } from './presence.service';
import {
  ConversationStateService,
  recordOutbox,
} from '../conversations/conversation-state.service';

type Tx = Prisma.TransactionClient;
type Headers = Record<string, string | string[] | undefined>;
export interface IdentityRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  query: URLSearchParams;
  ip: string;
}
type Result = { data?: unknown; status?: number; cookie?: string };
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const orgSelect = {
  id: true,
  name: true,
  timezone: true,
  version: true,
  aiEnabled: true,
} as const;
const userView = (u: {
  id: string;
  displayName: string;
  emailNormalized: string;
}) => ({ id: u.id, displayName: u.displayName, email: u.emailNormalized });
const canonical = (body: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(body).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

@Injectable()
export class IdentityService implements OnModuleDestroy {
  constructor(
    @Inject(PresenceService) readonly presence: PresenceService,
    @Inject(ConversationStateService)
    private readonly states: ConversationStateService,
  ) {}
  readonly db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: settings().databaseUrl }),
  });
  readonly origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:3100';
  private readonly attempts = new Map<
    string,
    { count: number; until: number }
  >();
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
  private header(r: IdentityRequest, name: string) {
    const value = r.headers[name];
    return typeof value === 'string' ? value : '';
  }
  private cookie(token: string, clear = false) {
    return `smartdesk_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 604800}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
  }
  private token(r: IdentityRequest) {
    return (
      this.header(r, 'cookie')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('smartdesk_session='))
        ?.slice(18) ?? ''
    );
  }
  private throttle(r: IdentityRequest) {
    const now = Date.now();
    for (const [key, value] of this.attempts)
      if (value.until < now) this.attempts.delete(key);
    const key = `${r.ip}:${r.path}`;
    const item = this.attempts.get(key) ?? { count: 0, until: now + 900000 };
    if (this.attempts.size >= 10000 && !this.attempts.has(key))
      fail(429, 'RATE_LIMITED', '请稍后重试');
    item.count++;
    this.attempts.set(key, item);
    if (item.count > 30) fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
  }
  private async session(
    tx: Tx,
    r: IdentityRequest,
    lock: boolean | 'share' = false,
  ) {
    const token = this.token(r);
    if (!/^[a-f0-9]{64}$/.test(token))
      return fail(401, 'UNAUTHENTICATED', '请重新登录');
    if (lock === 'share')
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE token_hash=${hash(token)} FOR SHARE`;
    else if (lock)
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE token_hash=${hash(token)} FOR UPDATE`;
    const s = await tx.authSession.findUnique({
      where: { tokenHash: hash(token) },
      include: { user: true },
    });
    if (
      !s ||
      s.revokedAt ||
      s.expiresAt <= new Date() ||
      s.user.status !== 'active'
    )
      return fail(401, 'UNAUTHENTICATED', '请重新登录');
    return s;
  }
  async membership(
    tx: Tx,
    r: IdentityRequest,
    org: string,
    admin = false,
    lock = false,
  ) {
    const s = await this.session(tx, r, lock ? 'share' : false);
    if (lock)
      await tx.$queryRaw`SELECT id FROM memberships WHERE organization_id=${org}::uuid AND user_id=${s.userId}::uuid FOR SHARE`;
    const m = await tx.membership.findUnique({
      where: {
        organizationId_userId: { organizationId: org, userId: s.userId },
      },
      select: memberSelect,
    });
    if (!m || m.status !== 'active')
      return fail(404, 'NOT_FOUND', '企业不可访问');
    if (admin && m.role !== 'admin')
      return fail(403, 'FORBIDDEN', '需要管理员权限');
    return m;
  }
  org(r: IdentityRequest, pathId?: string) {
    const id = uuid(this.header(r, 'x-organization-id'));
    if (pathId && id !== uuid(pathId)) fail(404, 'NOT_FOUND', '企业不可访问');
    return id;
  }
  async heartbeat(
    r: IdentityRequest,
    connectionId: string,
    socketId: string | null = null,
  ) {
    if (r.headers.authorization !== undefined)
      fail(403, 'FORBIDDEN', '访客不能登记成员在线状态');
    const org = this.org(r);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id=${org}::uuid FOR SHARE`;
      const s = await this.session(tx, r, 'share');
      const m = await this.membership(tx, r, org, false, true);
      return this.presence.heartbeat(
        tx,
        org,
        m.id,
        s.id,
        connectionId,
        socketId,
      );
    });
  }
  /** Organization lock precedes session/member/invitation locks for every tenant mutation. */
  async mutate(
    r: IdentityRequest,
    org: string | null,
    operation: string,
    body: Record<string, unknown>,
    work: (
      tx: Tx,
      userId: string,
      actorId: string | null,
      replay: Record<string, unknown> | null,
    ) => Promise<{
      ref: Record<string, string>;
      data?: unknown;
      status?: number;
    }>,
    admin = true,
  ): Promise<Result> {
    const commandId = uuid(this.header(r, 'idempotency-key'));
    return this.db.$transaction(async (tx) => {
      if (org)
        await tx.$queryRaw`SELECT id FROM organizations WHERE id=${org}::uuid FOR UPDATE`;
      const s = await this.session(tx, r, true);
      if (!org)
        await tx.$queryRaw`SELECT id FROM users WHERE id=${s.userId}::uuid FOR UPDATE`;
      const actor = org ? await this.membership(tx, r, org, admin) : null;
      const actorScope = org
        ? `member:${org}:${s.userId}`
        : `account:${s.userId}`;
      const key = { actorScope, operation, commandId };
      const digest = hash(canonical(body));
      const previous = await tx.operationReceipt.findUnique({
        where: { actorScope_operation_commandId: key },
      });
      if (previous && previous.requestHash !== digest)
        fail(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同内容');
      const result = await work(
        tx,
        s.userId,
        actor?.id ?? null,
        previous?.responseRef as Record<string, unknown> | null,
      );
      if (!previous) {
        await tx.operationReceipt.create({
          data: {
            ...key,
            organizationId: org,
            requestHash: digest,
            responseRef: result.ref,
          },
        });
        if (org)
          await tx.auditEvent.create({
            data: {
              organizationId: org,
              actorMembershipId: actor?.id,
              action: operation,
              resourceType: operation.split('.')[0]!,
              resourceId: result.ref.id!,
              requestId: r.requestId,
            },
          });
      }
      return {
        data: result.data,
        status: previous && result.status === 201 ? 200 : result.status,
      };
    });
  }
  private page(r: IdentityRequest, scope: string) {
    const limit = Number(r.query.get('limit') ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail(422, 'INVALID_INPUT', '分页数量应为1—100');
    let after: string | undefined;
    const cursor = r.query.get('cursor');
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(cursor, 'base64url').toString(),
        );
        const c = object(parsed, ['scope', 'id']);
        if (c.scope !== scope)
          fail(422, 'INVALID_CURSOR', '游标不属于当前列表');
        after = uuid(c.id);
      } catch {
        fail(422, 'INVALID_CURSOR', '分页游标无效');
      }
    }
    return {
      limit,
      after,
      finish: <T extends { id: string }>(rows: T[]) => ({
        items: rows.slice(0, limit),
        nextCursor:
          rows.length > limit
            ? Buffer.from(
                JSON.stringify({ scope, id: rows[limit - 1]!.id }),
              ).toString('base64url')
            : null,
      }),
    };
  }
  async handle(r: IdentityRequest): Promise<Result> {
    if (r.headers.authorization !== undefined && r.path.startsWith('/auth/'))
      fail(401, 'UNAUTHENTICATED', '成员认证接口不接受访客凭据');
    if (r.headers.authorization !== undefined)
      fail(403, 'FORBIDDEN', '成员接口不接受访客凭据');
    const write = r.method !== 'GET';
    if (
      write &&
      (this.header(r, 'origin') !== this.origin ||
        this.header(r, 'x-requested-with') !== 'SmartDesk' ||
        !/^application\/json(?:;|$)/i.test(this.header(r, 'content-type')))
    )
      fail(403, 'CSRF_REJECTED', '请求来源无效');
    if (
      ['/auth/register', '/auth/login', '/invitations/preview'].includes(r.path)
    )
      this.throttle(r);
    if (
      r.method === 'POST' &&
      ['/auth/register', '/auth/login'].includes(r.path)
    ) {
      const register = r.path.endsWith('register');
      const b = object(
        r.body,
        register ? ['email', 'password', 'displayName'] : ['email', 'password'],
      );
      const email = text(b.email, 3, 254).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        fail(422, 'INVALID_INPUT', '邮箱格式无效');
      const password = text(b.password, 12, 128);
      const displayName = register ? text(b.displayName, 1, 100).trim() : '';
      if (register && !displayName) fail(422, 'INVALID_INPUT', '请填写显示名');
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 604800000);
      const passwordHash = register
        ? await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 19456,
            timeCost: 2,
            parallelism: 1,
          })
        : undefined;
      const result = await this.db.$transaction(async (tx) => {
        let user = await tx.user.findUnique({
          where: { emailNormalized: email },
        });
        if (register) {
          if (user) return fail(409, 'EMAIL_EXISTS', '邮箱已注册');
          user = await tx.user.create({
            data: {
              emailNormalized: email,
              displayName,
              passwordHash: passwordHash!,
            },
          });
        } else {
          // Unknown accounts still perform the same password work before generic rejection.
          if (!user) {
            await argon2.hash(password, {
              type: argon2.argon2id,
              memoryCost: 19456,
              timeCost: 2,
              parallelism: 1,
            });
            return fail(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
          }
          if (
            user.status !== 'active' ||
            !(await argon2.verify(user.passwordHash, password))
          )
            return fail(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
        }
        await tx.authSession.create({
          data: { userId: user.id, tokenHash: hash(token), expiresAt },
        });
        return userView(user);
      });
      return {
        data: register ? result : { ...result, expiresAt },
        status: register ? 201 : 200,
        cookie: this.cookie(token),
      };
    }
    if (r.method === 'POST' && r.path === '/auth/logout') {
      object(r.body ?? {}, []);
      await this.db.$transaction(async (tx) => {
        const token = this.token(r);
        await tx.$queryRaw`SELECT id FROM auth_sessions WHERE token_hash=${hash(token)} FOR UPDATE`;
        const s = await tx.authSession.findUnique({
          where: { tokenHash: hash(token) },
        });
        if (s) {
          await tx.authSession.update({
            where: { id: s.id },
            data: { revokedAt: s.revokedAt ?? new Date() },
          });
          await tx.presenceConnection.updateMany({
            where: { authSessionId: s.id, disconnectedAt: null },
            data: { disconnectedAt: new Date() },
          });
        }
      });
      return { status: 204, cookie: this.cookie('', true) };
    }
    if (r.method === 'GET' && r.path === '/auth/me') {
      const s = await this.session(this.db, r);
      const memberships = await this.db.membership.findMany({
        where: { userId: s.userId, status: 'active' },
        select: { id: true, organizationId: true, role: true },
      });
      return { data: { ...userView(s.user), memberships } };
    }
    if (r.path === '/organizations' && r.method === 'POST') {
      const b = object(r.body, ['name', 'timezone']);
      const name = text(b.name, 1, 100).trim();
      if (!name) fail(422, 'INVALID_INPUT', '企业名不能为空');
      const zone = timezone(b.timezone);
      return this.mutate(
        r,
        null,
        'organization.create',
        { name, timezone: zone },
        async (tx, userId, _actor, replay) => {
          if (replay) {
            const id = uuid(replay.id);
            const m = await this.membership(tx, r, id);
            const o = await tx.organization.findUniqueOrThrow({
              where: { id },
              select: orgSelect,
            });
            return {
              ref: { id },
              data: {
                ...o,
                membership: (await this.presence.views(tx, o.id, [m]))[0],
              },
              status: 201,
            };
          }
          const o = await tx.organization.create({
            data: {
              name,
              timezone: zone,
              aiSenderId: randomUUID(),
              systemSenderId: randomUUID(),
            },
            select: orgSelect,
          });
          const m = await tx.membership.create({
            data: { organizationId: o.id, userId, role: 'admin' },
            select: memberSelect,
          });
          await tx.widgetConfig.create({ data: { organizationId: o.id } });
          await tx.auditEvent.create({
            data: {
              organizationId: o.id,
              actorMembershipId: m.id,
              action: 'organization.create',
              resourceType: 'organization',
              resourceId: o.id,
              requestId: r.requestId,
            },
          });
          return {
            ref: { id: o.id },
            data: {
              ...o,
              membership: (await this.presence.views(tx, o.id, [m]))[0],
            },
            status: 201,
          };
        },
      );
    }
    if (r.path === '/organizations' && r.method === 'GET') {
      const s = await this.session(this.db, r);
      const p = this.page(r, `org:${s.userId}`);
      const rows = await this.db.organization.findMany({
        where: {
          id: p.after ? { gt: p.after } : undefined,
          Membership_organization: {
            some: { userId: s.userId, status: 'active' },
          },
        },
        select: orgSelect,
        orderBy: { id: 'asc' },
        take: p.limit + 1,
      });
      return { data: p.finish(rows) };
    }
    const orgMatch = /^\/organizations\/([^/]+)$/.exec(r.path);
    if (orgMatch) {
      const org = this.org(r, orgMatch[1]);
      if (r.method === 'GET') {
        const m = await this.membership(this.db, r, org);
        const o = await this.db.organization.findUniqueOrThrow({
          where: { id: org },
          select: orgSelect,
        });
        return {
          data: {
            ...o,
            ...(m.role === 'admin'
              ? {
                  aiHealth: {
                    knowledgeReadyCount: await this.db.knowledgeDocument.count({
                      where: {
                        organizationId: org,
                        status: 'enabled',
                        deletedAt: null,
                        currentVersion: { is: { preparationStatus: 'ready' } },
                      },
                    }),
                    providerState: 'unverified',
                    observedAt: new Date(),
                  },
                }
              : {}),
          },
        };
      }
      if (r.method === 'PATCH') {
        const b = object(r.body, [
          'expectedVersion',
          'name',
          'timezone',
          'aiEnabled',
        ]);
        const expected = version(b.expectedVersion);
        const patch: { name?: string; timezone?: string; aiEnabled?: boolean } =
          {};
        if (b.name !== undefined) {
          patch.name = text(b.name, 1, 100).trim();
          if (!patch.name) fail(422, 'INVALID_INPUT', '企业名不能为空');
        }
        if (b.timezone !== undefined) patch.timezone = timezone(b.timezone);
        if (b.aiEnabled !== undefined) {
          if (typeof b.aiEnabled !== 'boolean')
            fail(422, 'INVALID_INPUT', '开关必须为布尔值');
          patch.aiEnabled = b.aiEnabled as boolean;
        }
        return this.mutate(
          r,
          org,
          'organization.update',
          { id: org, ...b },
          async (tx, _u, actorId, replay) => {
            const o = await tx.organization.findUniqueOrThrow({
              where: { id: org },
            });
            if (!replay) {
              if (o.version !== expected)
                fail(409, 'VERSION_CONFLICT', '企业资料已更新，请刷新');
              if (patch.aiEnabled === false)
                await this.states.compensate(
                  tx,
                  org,
                  actorId!,
                  uuid(this.header(r, 'idempotency-key')),
                );
              await tx.organization.update({
                where: { id: org },
                data: {
                  ...patch,
                  version: { increment: 1 },
                  ...(patch.aiEnabled !== undefined &&
                  patch.aiEnabled !== o.aiEnabled
                    ? { aiConfigRevision: { increment: 1 } }
                    : {}),
                },
              });
            }
            return {
              ref: { id: org },
              data: await tx.organization.findUniqueOrThrow({
                where: { id: org },
                select: orgSelect,
              }),
            };
          },
        );
      }
    }
    if (r.path === '/memberships' && r.method === 'GET') {
      const org = this.org(r);
      await this.membership(this.db, r, org);
      const status = r.query.get('status');
      if (status) choice(status, ['active', 'disabled']);
      const p = this.page(r, `members:${org}:${status ?? ''}`);
      const rows = await this.db.membership.findMany({
        where: {
          organizationId: org,
          status: status ?? undefined,
          id: p.after ? { gt: p.after } : undefined,
        },
        select: memberSelect,
        orderBy: { id: 'asc' },
        take: p.limit + 1,
      });
      return { data: p.finish(await this.presence.views(this.db, org, rows)) };
    }
    if (r.path === '/memberships/me/availability' && r.method === 'PATCH') {
      const org = this.org(r);
      const b = object(r.body, ['availability', 'readingLanguage']);
      const availability = choice(b.availability, ['available', 'away']);
      const readingLanguage =
        b.readingLanguage === undefined
          ? undefined
          : choice(b.readingLanguage, ['zh', 'en']);
      return this.mutate(
        r,
        org,
        'membership.availability',
        b,
        async (tx, _u, actorId, replay) => {
          if (!replay) {
            const m = await tx.membership.update({
              where: { id: actorId! },
              data: {
                availability,
                readingLanguage,
                version: { increment: 1 },
              },
            });
            await recordOutbox(
              tx,
              org,
              'membership',
              m.id,
              m.version,
              'membership.updated',
              { id: m.id, version: m.version },
            );
            await this.presence.notify(tx, org, m.id, m.version);
          }
          const m = await tx.membership.findUniqueOrThrow({
            where: { id: actorId! },
            select: memberSelect,
          });
          return {
            ref: { id: m.id },
            data: (await this.presence.views(tx, org, [m]))[0],
          };
        },
        false,
      ).catch((error: unknown) => {
        // A015 addresses the caller's own preference; its contract uses 403 for inactive membership.
        if (error instanceof ApiError && error.code === 'NOT_FOUND')
          fail(403, 'FORBIDDEN', '需要有效企业成员身份');
        throw error;
      });
    }
    if (r.path === '/presence/heartbeat' && r.method === 'POST') {
      const b = object(r.body, ['connectionId']);
      return {
        data: await this.heartbeat(r, uuid(b.connectionId).toLowerCase()),
      };
    }
    if (r.path === '/presence' && r.method === 'GET') {
      if (r.query.size) fail(422, 'INVALID_INPUT', '不支持查询字段');
      const org = this.org(r);
      return this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id=${org}::uuid FOR SHARE`;
        await this.membership(tx, r, org, false, true);
        const rows = await tx.membership.findMany({
          where: {
            organizationId: org,
            status: 'active',
            availability: 'available',
          },
          select: memberSelect,
          orderBy: { id: 'asc' },
        });
        return {
          data: (await this.presence.views(tx, org, rows)).filter(
            (m) => m.online,
          ),
        };
      });
    }
    const memberMatch = /^\/memberships\/([^/]+)$/.exec(r.path);
    if (memberMatch && r.method === 'PATCH') {
      const org = this.org(r);
      const id = uuid(memberMatch[1]);
      const b = object(r.body, ['expectedVersion', 'role', 'status']);
      const expected = version(b.expectedVersion);
      const role =
        b.role === undefined ? undefined : choice(b.role, ['admin', 'agent']);
      const status =
        b.status === undefined
          ? undefined
          : choice(b.status, ['active', 'disabled']);
      return this.mutate(
        r,
        org,
        'membership.update',
        { id, ...b },
        async (tx, _u, actorId, replay) => {
          const m = await tx.membership.findFirst({
            where: { id, organizationId: org },
            select: memberSelect,
          });
          if (!m) return fail(404, 'NOT_FOUND', '成员不存在');
          if (!replay) {
            if (m.version !== expected)
              fail(409, 'VERSION_CONFLICT', '成员资料已更新');
            if (
              m.role === 'admin' &&
              m.status === 'active' &&
              (role === 'agent' || status === 'disabled') &&
              (await tx.membership.count({
                where: { organizationId: org, role: 'admin', status: 'active' },
              })) <= 1
            )
              fail(409, 'LAST_ADMIN_REQUIRED', '必须保留至少一位有效管理员');
            if (status === 'disabled')
              await this.states.compensate(
                tx,
                org,
                actorId!,
                uuid(this.header(r, 'idempotency-key')),
                id,
              );
            await tx.membership.update({
              where: { id },
              data: { role, status, version: { increment: 1 } },
            });
            await tx.organization.update({
              where: { id: org },
              data: { authorizationRevision: { increment: 1 } },
            });
            await tx.presenceConnection.updateMany({
              where: {
                organizationId: org,
                membershipId: id,
                disconnectedAt: null,
              },
              data: { disconnectedAt: new Date() },
            });
            await recordOutbox(
              tx,
              org,
              'membership',
              id,
              m.version + 1,
              'membership.updated',
              { id, version: m.version + 1 },
            );
            await this.presence.notify(tx, org, id, m.version + 1);
          }
          return {
            ref: { id },
            data: (
              await this.presence.views(tx, org, [
                await tx.membership.findUniqueOrThrow({
                  where: { id },
                  select: memberSelect,
                }),
              ])
            )[0],
          };
        },
      );
    }
    if (r.path === '/invitations' && r.method === 'POST') {
      const org = this.org(r);
      const b = object(r.body, ['role']);
      const role = choice(b.role, ['admin', 'agent']);
      return this.mutate(
        r,
        org,
        'invitation.create',
        { role },
        async (tx, _u, actor, replay) => {
          if (replay) {
            const i = await tx.invitation.findFirst({
              where: { id: uuid(replay.id), organizationId: org },
            });
            if (!i) return fail(404, 'NOT_FOUND', '邀请不存在');
            return {
              ref: { id: i.id },
              data: {
                id: i.id,
                expiresAt: i.expiresAt,
                inviteLink: null,
                linkUnavailable: true,
              },
              status: 201,
            };
          }
          const token = randomBytes(32).toString('hex');
          const i = await tx.invitation.create({
            data: {
              organizationId: org,
              role,
              createdByMembershipId: actor!,
              tokenHash: hash(token),
              expiresAt: new Date(Date.now() + 604800000),
            },
          });
          return {
            ref: { id: i.id },
            data: {
              id: i.id,
              expiresAt: i.expiresAt,
              inviteLink: `${this.origin}/invite#${token}`,
            },
            status: 201,
          };
        },
      );
    }
    if (r.path === '/invitations/preview' && r.method === 'POST') {
      const b = object(r.body, ['token']);
      const token = text(b.token, 64, 64);
      const i = await this.db.invitation.findUnique({
        where: { tokenHash: hash(token) },
        include: { organization: true },
      });
      if (!i || i.acceptedAt || i.revokedAt || i.expiresAt <= new Date())
        return fail(404, 'INVITATION_INVALID', '邀请已失效');
      return {
        data: {
          organizationName: i.organization.name,
          role: i.role,
          expiresAt: i.expiresAt,
        },
      };
    }
    if (r.path === '/invitations/accept' && r.method === 'POST') {
      const b = object(r.body, ['token']);
      const token = text(b.token, 64, 64);
      await this.session(this.db, r);
      const found = await this.db.invitation.findUnique({
        where: { tokenHash: hash(token) },
      });
      if (!found) return fail(404, 'INVITATION_INVALID', '邀请已失效');
      // Acceptance authorizes by the invitation, not a membership that does not yet exist.
      const key = uuid(this.header(r, 'idempotency-key'));
      return this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id=${found.organizationId}::uuid FOR UPDATE`;
        const s = await this.session(tx, r, true);
        await tx.$queryRaw`SELECT id FROM invitations WHERE id=${found.id}::uuid FOR UPDATE`;
        const i = await tx.invitation.findUniqueOrThrow({
          where: { id: found.id },
        });
        const receiptKey = {
          actorScope: `account:${s.userId}`,
          operation: 'invitation.accept',
          commandId: key,
        };
        const prev = await tx.operationReceipt.findUnique({
          where: { actorScope_operation_commandId: receiptKey },
        });
        if (prev && prev.requestHash !== hash(token))
          fail(409, 'IDEMPOTENCY_CONFLICT', '请求标识冲突');
        if (!prev) {
          if (i.revokedAt) fail(409, 'REVOKED', '邀请已撤销');
          if (i.acceptedAt) fail(409, 'CONSUMED', '邀请已使用');
          if (i.expiresAt <= new Date()) fail(409, 'EXPIRED', '邀请已过期');
        }
        let m = await tx.membership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: i.organizationId,
              userId: s.userId,
            },
          },
          select: memberSelect,
        });
        if (m?.status === 'disabled')
          fail(403, 'MEMBERSHIP_DISABLED', '请联系管理员恢复成员资格');
        if (!m)
          m = await tx.membership.create({
            data: {
              organizationId: i.organizationId,
              userId: s.userId,
              role: i.role,
            },
            select: memberSelect,
          });
        if (!prev) {
          await tx.invitation.update({
            where: { id: i.id },
            data: { acceptedAt: new Date(), acceptedByUserId: s.userId },
          });
          await tx.auditEvent.create({
            data: {
              organizationId: i.organizationId,
              actorMembershipId: m.id,
              action: 'invitation.accept',
              resourceType: 'invitation',
              resourceId: i.id,
              requestId: r.requestId,
            },
          });
          await tx.operationReceipt.create({
            data: {
              ...receiptKey,
              organizationId: i.organizationId,
              requestHash: hash(token),
              responseRef: { id: i.id },
            },
          });
        }
        return {
          data: {
            membership: (
              await this.presence.views(tx, i.organizationId, [m])
            )[0],
            organization: await tx.organization.findUniqueOrThrow({
              where: { id: i.organizationId },
              select: orgSelect,
            }),
          },
        };
      });
    }
    const revoke = /^\/invitations\/([^/]+)\/revoke$/.exec(r.path);
    if (revoke && r.method === 'POST') {
      const org = this.org(r);
      const id = uuid(revoke[1]);
      object(r.body ?? {}, []);
      return this.mutate(r, org, 'invitation.revoke', { id }, async (tx) => {
        const i = await tx.invitation.findFirst({
          where: { id, organizationId: org },
        });
        if (!i) return fail(404, 'NOT_FOUND', '邀请不存在');
        if (i.acceptedAt) fail(409, 'CONSUMED', '邀请已使用');
        if (!i.revokedAt)
          await tx.invitation.update({
            where: { id },
            data: { revokedAt: new Date() },
          });
        return { ref: { id }, status: 204 };
      });
    }
    if (r.path === '/invitations' && r.method === 'GET') {
      const org = this.org(r);
      await this.membership(this.db, r, org, true);
      const status = r.query.get('status');
      if (status) choice(status, ['pending', 'accepted', 'revoked', 'expired']);
      const now = new Date();
      const filter =
        status === 'accepted'
          ? { acceptedAt: { not: null } }
          : status === 'revoked'
            ? { revokedAt: { not: null } }
            : status === 'expired'
              ? { acceptedAt: null, revokedAt: null, expiresAt: { lte: now } }
              : status === 'pending'
                ? { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }
                : {};
      const p = this.page(r, `invites:${org}:${status ?? ''}`);
      const rows = await this.db.invitation.findMany({
        where: {
          organizationId: org,
          ...filter,
          id: p.after ? { gt: p.after } : undefined,
        },
        select: {
          id: true,
          role: true,
          expiresAt: true,
          createdAt: true,
          acceptedAt: true,
          revokedAt: true,
        },
        orderBy: { id: 'asc' },
        take: p.limit + 1,
      });
      return {
        data: p.finish(
          rows.map(({ revokedAt, ...i }) => ({
            ...i,
            status: i.acceptedAt
              ? 'accepted'
              : revokedAt
                ? 'revoked'
                : i.expiresAt <= now
                  ? 'expired'
                  : 'pending',
          })),
        ),
      };
    }
    return fail(404, 'NOT_FOUND', '接口不存在');
  }
}
