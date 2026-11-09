import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, WidgetConfig } from '../../generated/prisma/client';
import {
  IdentityService,
  type IdentityRequest,
} from '../identity/identity.service';
import { choice, fail, object, text, uuid, version } from '../identity/input';
import { ReceiptCipher } from './receipt-cipher';
import type { VisitorBootstrap, WidgetPublicView } from '@smartdesk/shared';

type Tx = Prisma.TransactionClient;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const header = (r: IdentityRequest, name: string) =>
  typeof r.headers[name] === 'string' ? (r.headers[name] as string) : '';
const customerSelect = {
  id: true,
  name: true,
  email: true,
  preferredLanguage: true,
  version: true,
} as const;
const canonical = (value: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
export function exactOrigin(value: unknown) {
  try {
    const input = text(value, 1, 2048);
    const url = new URL(input);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== input ||
      input.includes('*')
    )
      throw new Error('origin');
    return input;
  } catch {
    return fail(
      422,
      'INVALID_ORIGIN',
      '来源必须为精确的 HTTP(S) scheme、host 和 port',
    );
  }
}
@Injectable()
export class WidgetService implements OnModuleInit, OnModuleDestroy {
  readonly origin = exactOrigin(
    process.env.WIDGET_ORIGIN ??
      process.env.APP_ORIGIN ??
      'http://127.0.0.1:3100',
  );
  private readonly cipher = new ReceiptCipher();
  private cleanup?: ReturnType<typeof setInterval>;
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  onModuleInit() {
    this.cleanup = setInterval(() => {
      void this.expireReceipts().catch(() => undefined);
    }, 30000);
    this.cleanup.unref();
    void this.expireReceipts().catch(() => undefined);
  }
  onModuleDestroy() {
    if (this.cleanup) clearInterval(this.cleanup);
  }
  async expireReceipts() {
    // Keep the idempotency tombstone; never make an expired command look new.
    await this.identity.db
      .$executeRaw`UPDATE operation_receipts SET response_ref = jsonb_build_object('visitorSessionId', response_ref->>'visitorSessionId', 'expired', true) WHERE operation='visitor.bootstrap' AND secret_expires_at <= now() AND response_ref ? 'ciphertext'`;
  }
  private publicView(w: WidgetConfig): WidgetPublicView {
    return {
      publicKey: w.publicKey,
      welcomeText: w.welcomeText,
      defaultLanguage: w.defaultLanguage,
      iframeUrl: `${this.origin}/widget/${w.publicKey}`,
    };
  }
  private adminView(w: WidgetConfig) {
    return {
      ...this.publicView(w),
      allowedOrigins: w.allowedOrigins,
      enabled: w.enabled,
      version: w.version,
      loaderUrl: `${this.origin}/widget-loader.js`,
    };
  }
  private allowed(w: WidgetConfig, origin: string) {
    if (!w.enabled) fail(403, 'WIDGET_DISABLED', '客服入口尚未启用');
    if (
      !origin ||
      !Array.isArray(w.allowedOrigins) ||
      !w.allowedOrigins.includes(origin)
    )
      fail(403, 'ORIGIN_NOT_ALLOWED', '此网站未获准接入');
  }
  async publicConfig(key: string, origin: string) {
    const widget = await this.identity.db.widgetConfig.findUnique({
      where: { publicKey: uuid(key) },
    });
    if (!widget) return fail(404, 'NOT_FOUND', '客服入口不存在');
    this.allowed(widget, origin);
    return widget;
  }
  async config(r: IdentityRequest) {
    const org = this.identity.org(r);
    if (r.method === 'GET') {
      await this.identity.membership(this.identity.db, r, org, true);
      const w = await this.identity.db.widgetConfig.findUnique({
        where: { organizationId: org },
      });
      if (!w) return fail(404, 'NOT_FOUND', '配置不存在');
      return { data: this.adminView(w) };
    }
    if (r.method !== 'PATCH')
      return fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
    if (
      header(r, 'origin') !== this.identity.origin ||
      header(r, 'x-requested-with') !== 'SmartDesk'
    )
      fail(403, 'CSRF_REJECTED', '请求来源无效');
    const b = object(r.body, [
      'expectedVersion',
      'allowedOrigins',
      'welcomeText',
      'defaultLanguage',
      'enabled',
    ]);
    const expected = version(b.expectedVersion);
    const data: Prisma.WidgetConfigUpdateInput = {};
    if (b.allowedOrigins !== undefined) {
      if (!Array.isArray(b.allowedOrigins))
        return fail(422, 'INVALID_ORIGIN', '来源列表无效');
      data.allowedOrigins = [...new Set(b.allowedOrigins.map(exactOrigin))];
    }
    if (b.welcomeText !== undefined)
      data.welcomeText = text(b.welcomeText, 0, 500);
    if (b.defaultLanguage !== undefined)
      data.defaultLanguage = choice(b.defaultLanguage, ['zh', 'en']);
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean')
        return fail(422, 'INVALID_INPUT', '启用状态无效');
      data.enabled = b.enabled;
    }
    return this.identity.mutate(
      r,
      org,
      'widget.update',
      b,
      async (tx, _user, _actor, replay) => {
        const w = await tx.widgetConfig.findUniqueOrThrow({
          where: { organizationId: org },
        });
        if (replay) return { ref: { id: w.id }, data: this.adminView(w) };
        if (w.version !== expected)
          return fail(409, 'VERSION_CONFLICT', '配置已更新，请刷新后重试');
        const updated = await tx.widgetConfig.update({
          where: { id: w.id },
          data: { ...data, version: { increment: 1 } },
        });
        return { ref: { id: w.id }, data: this.adminView(updated) };
      },
    );
  }
  async bootstrap(r: IdentityRequest, initial: WidgetConfig) {
    const body = object(r.body, ['resumeToken']);
    const resume =
      body.resumeToken === undefined
        ? undefined
        : text(body.resumeToken, 64, 64);
    if (resume && !/^[a-f0-9]{64}$/.test(resume))
      fail(401, 'INVALID_VISITOR_TOKEN', '访客凭据无效');
    const commandId = uuid(header(r, 'idempotency-key'));
    const origin = header(r, 'origin');
    const actorScope = `widget:${initial.publicKey}:${origin}`;
    const requestHash = hash(canonical(body));
    const key = { actorScope, operation: 'visitor.bootstrap', commandId };
    this.cipher.ready();
    const result = await this.identity.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id=${initial.organizationId}::uuid FOR UPDATE`;
      const w = await tx.widgetConfig.findUniqueOrThrow({
        where: { id: initial.id },
      });
      this.allowed(w, origin);
      const previous = await tx.operationReceipt.findUnique({
        where: { actorScope_operation_commandId: key },
      });
      if (previous) {
        if (previous.requestHash !== requestHash)
          return fail(
            409,
            'IDEMPOTENCY_CONFLICT',
            '同一请求标识不能用于不同内容',
          );
        const ref = previous.responseRef as Record<string, unknown>;
        if (
          !previous.secretExpiresAt ||
          previous.secretExpiresAt <= new Date() ||
          ref.expired
        ) {
          await tx.operationReceipt.update({
            where: { id: previous.id },
            data: {
              responseRef: {
                visitorSessionId: String(ref.visitorSessionId),
                expired: true,
              },
            },
          });
          return { expired: true };
        }
        const session = await tx.visitorSession.findUnique({
          where: { id: String(ref.visitorSessionId) },
        });
        if (!session || session.revokedAt || session.expiresAt <= new Date())
          return fail(401, 'INVALID_VISITOR_TOKEN', '访客凭据已失效');
        const aad = JSON.stringify([
          actorScope,
          commandId,
          requestHash,
          previous.secretExpiresAt.toISOString(),
        ]);
        return { data: this.cipher.open(ref, aad), status: 200 };
      }
      let session = resume
        ? await tx.visitorSession.findUnique({
            where: { tokenHash: hash(resume) },
          })
        : null;
      if (
        resume &&
        (!session ||
          session.widgetConfigId !== w.id ||
          session.parentOrigin !== origin ||
          session.revokedAt)
      )
        return fail(
          401,
          'INVALID_VISITOR_TOKEN',
          '访客凭据不属于此网站或已失效',
        );
      const identityReset = !!session && session.expiresAt <= new Date();
      if (identityReset) session = null;
      let visitorToken: string | undefined;
      if (!session) {
        visitorToken = randomBytes(32).toString('hex');
        const customer = await tx.customer.create({
          data: {
            organizationId: w.organizationId,
            preferredLanguage: w.defaultLanguage,
          },
        });
        session = await tx.visitorSession.create({
          data: {
            organizationId: w.organizationId,
            widgetConfigId: w.id,
            customerId: customer.id,
            parentOrigin: origin,
            tokenHash: hash(visitorToken),
            expiresAt: new Date(Date.now() + 30 * 86400000),
          },
        });
      }
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: session.customerId },
        select: customerSelect,
      });
      const data: VisitorBootstrap = {
        ...(visitorToken ? { visitorToken } : {}),
        expiresAt: session.expiresAt.toISOString(),
        customer,
        widget: this.publicView(w),
        identityReset,
      };
      const secretExpiresAt = new Date(Date.now() + 600000);
      const aad = JSON.stringify([
        actorScope,
        commandId,
        requestHash,
        secretExpiresAt.toISOString(),
      ]);
      await tx.operationReceipt.create({
        data: {
          ...key,
          organizationId: w.organizationId,
          requestHash,
          secretExpiresAt,
          responseRef: {
            visitorSessionId: session.id,
            ...this.cipher.seal(data, aad),
          },
        },
      });
      return { data, status: visitorToken ? 201 : 200 };
    });
    // Throw only after committing the expiry tombstone.
    if (result.expired)
      return fail(
        409,
        'BOOTSTRAP_RECEIPT_EXPIRED',
        '恢复窗口已过期，请明确选择开始新的咨询身份',
      );
    return result;
  }
  /** Shared visitor boundary for later conversation endpoints; never falls back to cookies. */
  async visitor(tx: Tx, r: IdentityRequest, lock?: 'share' | 'update') {
    const origin = header(r, 'origin');
    const site = header(r, 'sec-fetch-site');
    /** Same-origin GET may omit Origin; Bearer and its live site binding remain mandatory. */
    if (
      (origin && origin !== this.origin) ||
      (!origin &&
        (r.method !== 'GET' ||
          (site && !['same-origin', 'none'].includes(site))))
    )
      return fail(403, 'ORIGIN_NOT_ALLOWED', '访客请求来源无效');
    const token = /^Bearer ([a-f0-9]{64})$/.exec(
      header(r, 'authorization'),
    )?.[1];
    if (!token) return fail(401, 'INVALID_VISITOR_TOKEN', '需要有效访客凭据');
    if (lock === 'share')
      await tx.$queryRaw`SELECT id FROM visitor_sessions WHERE token_hash=${hash(token)} FOR SHARE`;
    else if (lock === 'update')
      await tx.$queryRaw`SELECT id FROM visitor_sessions WHERE token_hash=${hash(token)} FOR UPDATE`;
    const session = await tx.visitorSession.findUnique({
      where: { tokenHash: hash(token) },
      include: { widgetConfig: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date())
      return fail(401, 'INVALID_VISITOR_TOKEN', '访客凭据已失效');
    this.allowed(session.widgetConfig, session.parentOrigin);
    return session;
  }
  async updateCustomer(r: IdentityRequest, customerId: string) {
    uuid(customerId);
    const initial = await this.visitor(this.identity.db, r);
    if (initial.customerId !== customerId)
      return fail(404, 'NOT_FOUND', '客户不可访问');
    const b = object(r.body, [
      'expectedVersion',
      'name',
      'email',
      'preferredLanguage',
    ]);
    const expected = version(b.expectedVersion);
    const data: Prisma.CustomerUpdateInput = {};
    if (b.name !== undefined) data.name = text(b.name, 0, 100);
    if (b.email !== undefined) {
      const email = text(b.email, 0, 254).trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return fail(422, 'INVALID_INPUT', '邮箱格式无效');
      data.email = email;
      data.emailNormalized = email ? email.toLowerCase() : null;
    }
    if (b.preferredLanguage !== undefined)
      data.preferredLanguage = choice(b.preferredLanguage, ['zh', 'en']);
    const key = {
      actorScope: `visitor:${initial.id}`,
      operation: 'customer.update',
      commandId: uuid(header(r, 'idempotency-key')),
    };
    const requestHash = hash(canonical({ ...b, customerId }));
    return this.identity.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id=${initial.organizationId}::uuid FOR UPDATE`;
      await this.visitor(tx, r);
      const previous = await tx.operationReceipt.findUnique({
        where: { actorScope_operation_commandId: key },
      });
      if (previous && previous.requestHash !== requestHash)
        return fail(
          409,
          'IDEMPOTENCY_CONFLICT',
          '同一请求标识不能用于不同内容',
        );
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: customerSelect,
      });
      if (previous) return { data: customer };
      if (customer.version !== expected)
        return fail(409, 'VERSION_CONFLICT', '资料已更新，请刷新后重试');
      const updated = await tx.customer.update({
        where: { id: customerId },
        data: { ...data, version: { increment: 1 } },
        select: customerSelect,
      });
      await tx.operationReceipt.create({
        data: {
          ...key,
          organizationId: initial.organizationId,
          requestHash,
          responseRef: { id: customerId },
        },
      });
      return { data: updated };
    });
  }
  view(w: WidgetConfig) {
    return this.publicView(w);
  }
}
