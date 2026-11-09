import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  KnowledgeSummary,
  KnowledgeView,
  KnowledgeVersionMetadata,
} from '@smartdesk/shared';
import type { KnowledgeVersion, Prisma } from '../../generated/prisma/client';
import {
  IdentityService,
  type IdentityRequest,
} from '../identity/identity.service';
import { choice, fail, object, text, uuid, version } from '../identity/input';
import { recordOutbox } from '../conversations/conversation-state.service';

type Tx = Prisma.TransactionClient;
type Document = Prisma.KnowledgeDocumentGetPayload<{
  include: { currentVersion: true };
}>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Immutable profile identity keeps unconfigured drafts distinct from actual indexed knowledge. */
function embeddingProfile() {
  const mode = process.env.AI_MODE ?? 'disabled';
  if (mode === 'fake')
    return {
      embeddingModelId: 'fake-embedding-v1',
      embeddingDimensions: 8,
      embeddingProfileVersion: 'fake-embedding-v1:8:v1',
    };
  const model = process.env.AI_EMBEDDING_MODEL_ID?.trim();
  const dimensions = Number(process.env.AI_EMBEDDING_DIMENSIONS);
  if (
    mode === 'openai_compatible' &&
    model &&
    Number.isInteger(dimensions) &&
    dimensions >= 1 &&
    dimensions <= 16000
  )
    return {
      embeddingModelId: model,
      embeddingDimensions: dimensions,
      embeddingProfileVersion: hash(
        JSON.stringify([mode, model, dimensions, 'v1']),
      ),
    };
  return {
    embeddingModelId: 'unconfigured',
    embeddingDimensions: 1,
    embeddingProfileVersion: 'unconfigured',
  };
}

function metadata(v: KnowledgeVersion): KnowledgeVersionMetadata {
  return {
    id: v.id,
    revision: v.revision,
    titleOrQuestion: v.titleOrQuestion,
    preparationStatus:
      v.preparationStatus === 'pending'
        ? 'not_started'
        : (v.preparationStatus as KnowledgeVersionMetadata['preparationStatus']),
    preparationRequested: v.preparationAttempt > 0,
    ...(v.lastErrorCode ? { lastErrorCode: v.lastErrorCode } : {}),
    createdAt: v.createdAt.toISOString(),
  };
}
function view(d: Document): KnowledgeView {
  if (!d.currentVersion)
    return fail(503, 'SERVICE_UNAVAILABLE', '知识版本不可用');
  return {
    id: d.id,
    type: d.type as KnowledgeView['type'],
    status: d.status as KnowledgeView['status'],
    version: d.version,
    currentVersion: {
      ...metadata(d.currentVersion),
      body: d.currentVersion.body,
    },
    updatedAt: d.updatedAt.toISOString(),
  };
}
function page(r: IdentityRequest, scope: string) {
  const limit = Number(r.query.get('limit') ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail(422, 'INVALID_INPUT', '分页数量应为1—100');
  let after: string | undefined;
  const cursor = r.query.get('cursor');
  if (cursor) {
    try {
      const c = object(
        JSON.parse(Buffer.from(cursor, 'base64url').toString()),
        ['scope', 'id'],
      );
      if (c.scope !== scope) throw new Error('scope');
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

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private async document(tx: Tx, org: string, id: string, admin: boolean) {
    const d = await tx.knowledgeDocument.findFirst({
      where: {
        id,
        organizationId: org,
        deletedAt: null,
        ...(!admin
          ? {
              status: 'enabled',
              currentVersion: { preparationStatus: 'ready' },
            }
          : {}),
      },
      include: { currentVersion: true },
    });
    if (!d) return fail(404, 'NOT_FOUND', '知识不可访问');
    return d;
  }
  private configured(v: KnowledgeVersion) {
    const profile = embeddingProfile();
    if (profile.embeddingProfileVersion === 'unconfigured')
      fail(503, 'AI_UNAVAILABLE', '尚未配置知识准备服务');
    if (v.embeddingProfileVersion !== profile.embeddingProfileVersion)
      fail(
        409,
        'EMBEDDING_PROFILE_CHANGED',
        '准备配置已变化，请编辑生成新版本',
      );
  }
  private async newVersion(
    tx: Tx,
    org: string,
    id: string,
    actor: string,
    revision: number,
    type: string,
    input: Record<string, unknown>,
  ) {
    const titleOrQuestion = text(
      typeof input.titleOrQuestion === 'string'
        ? input.titleOrQuestion.trim()
        : input.titleOrQuestion,
      1,
      200,
    );
    const body = text(
      typeof input.body === 'string' ? input.body.trim() : input.body,
      1,
      type === 'faq' ? 8000 : 50000,
    );
    return tx.knowledgeVersion.create({
      data: {
        organizationId: org,
        documentId: id,
        createdByMembershipId: actor,
        revision,
        titleOrQuestion,
        body,
        contentHash: hash(JSON.stringify([type, titleOrQuestion, body])),
        ...embeddingProfile(),
      },
    });
  }
  private async changed(tx: Tx, d: Document, revision: boolean) {
    if (revision)
      await tx.organization.update({
        where: { id: d.organizationId },
        data: { knowledgeRevision: { increment: 1 } },
      });
    await recordOutbox(
      tx,
      d.organizationId,
      'knowledge_document',
      d.id,
      d.version,
      'knowledge.updated',
      { id: d.id },
    );
  }
  async handle(
    r: IdentityRequest,
  ): Promise<{ data?: unknown; status?: number }> {
    if (r.headers.authorization !== undefined)
      fail(403, 'FORBIDDEN', '成员接口不接受访客凭据');
    const org = this.identity.org(r);
    const parts = r.path.split('/');
    const id = parts[2] ? uuid(parts[2]) : null;
    const action = parts[3];
    if (r.method === 'GET')
      return {
        data: await this.identity.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM organizations WHERE id=${org}::uuid FOR SHARE`;
          const member = await this.identity.membership(
            tx,
            r,
            org,
            false,
            true,
          );
          if (id) {
            const d = await this.document(tx, org, id, member.role === 'admin');
            if (!action) return view(d);
            if (action !== 'versions')
              return fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
            if (member.role !== 'admin')
              fail(403, 'FORBIDDEN', '需要管理员权限');
            const p = page(r, JSON.stringify([org, id, 'versions']));
            const rows = await tx.knowledgeVersion.findMany({
              where: {
                organizationId: org,
                documentId: id,
                ...(p.after ? { id: { gt: p.after } } : {}),
              },
              orderBy: { id: 'asc' },
              take: p.limit + 1,
            });
            return p.finish(rows.map(metadata));
          }
          const type = r.query.has('type')
            ? choice(r.query.get('type'), ['faq', 'text'])
            : undefined;
          const status = r.query.has('status')
            ? choice(r.query.get('status'), ['draft', 'enabled', 'disabled'])
            : undefined;
          const q = text(r.query.get('q') ?? '', 0, 200).trim();
          if (member.role !== 'admin' && status && status !== 'enabled')
            fail(403, 'FORBIDDEN', '只能查看已启用知识');
          const p = page(
            r,
            JSON.stringify([org, member.role, type, status, q]),
          );
          const rows = await tx.knowledgeDocument.findMany({
            where: {
              organizationId: org,
              deletedAt: null,
              type,
              status: member.role === 'admin' ? status : 'enabled',
              ...(p.after ? { id: { gt: p.after } } : {}),
              currentVersion: {
                ...(member.role !== 'admin'
                  ? { preparationStatus: 'ready' }
                  : {}),
                ...(q
                  ? {
                      OR: [
                        {
                          titleOrQuestion: { contains: q, mode: 'insensitive' },
                        },
                        { body: { contains: q, mode: 'insensitive' } },
                      ],
                    }
                  : {}),
              },
            },
            include: { currentVersion: true },
            orderBy: { id: 'asc' },
            take: p.limit + 1,
          });
          return p.finish(
            rows.map(
              (d) =>
                ({
                  ...view(d),
                  currentVersion: metadata(d.currentVersion!),
                }) satisfies KnowledgeSummary,
            ),
          );
        }),
      };
    if (
      r.headers.origin !== this.identity.origin ||
      r.headers['x-requested-with'] !== 'SmartDesk' ||
      typeof r.headers['content-type'] !== 'string' ||
      !/^application\/json(?:;|$)/i.test(r.headers['content-type'])
    )
      fail(403, 'CSRF_REJECTED', '请求来源无效');
    const operation =
      !id && r.method === 'POST'
        ? 'create'
        : id && !action && r.method === 'PATCH'
          ? 'edit'
          : id && !action && r.method === 'DELETE'
            ? 'delete'
            : id &&
                r.method === 'POST' &&
                ['prepare', 'enable', 'disable'].includes(action ?? '')
              ? action!
              : fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
    const fields = {
      create: ['type', 'titleOrQuestion', 'body'],
      edit: ['expectedVersion', 'titleOrQuestion', 'body'],
      prepare: ['versionId'],
      enable: ['expectedVersion', 'versionId'],
      disable: ['expectedVersion'],
      delete: [],
    };
    const input = object(
      r.body ?? {},
      fields[operation as keyof typeof fields],
    );
    const expected =
      operation === 'delete'
        ? version(
            Number(
              typeof r.headers['if-match'] === 'string' &&
                /^"?\d+"?$/.test(r.headers['if-match'])
                ? r.headers['if-match'].replaceAll('"', '')
                : NaN,
            ),
          )
        : ['edit', 'enable', 'disable'].includes(operation)
          ? version(input.expectedVersion)
          : undefined;
    const versionId = ['prepare', 'enable'].includes(operation)
      ? uuid(input.versionId)
      : undefined;
    const type =
      operation === 'create' ? choice(input.type, ['faq', 'text']) : undefined;
    return this.identity.mutate(
      r,
      org,
      `knowledge.${operation}`,
      {
        ...input,
        id,
        ...(expected !== undefined ? { expectedVersion: expected } : {}),
      },
      async (
        tx,
        _user,
        actor,
        replay,
      ): Promise<{
        ref: Record<string, string>;
        data?: unknown;
        status?: number;
      }> => {
        if (replay) {
          if (operation === 'delete')
            return { ref: { id: String(replay.id) }, status: 204 };
          const d = await this.document(tx, org, String(replay.id), true);
          return {
            ref: { id: d.id },
            data:
              operation === 'prepare'
                ? {
                    versionId: String(replay.versionId),
                    preparationStatus: metadata(
                      await tx.knowledgeVersion.findUniqueOrThrow({
                        where: { id: String(replay.versionId) },
                      }),
                    ).preparationStatus,
                    preparationRequested: true,
                  }
                : view(d),
            status: operation === 'prepare' ? 202 : 200,
          };
        }
        if (operation === 'create') {
          const d = await tx.knowledgeDocument.create({
            data: {
              organizationId: org,
              type: type!,
              createdByMembershipId: actor!,
            },
          });
          const v = await this.newVersion(
            tx,
            org,
            d.id,
            actor!,
            1,
            type!,
            input,
          );
          const result = await tx.knowledgeDocument.update({
            where: { id: d.id },
            data: { currentVersionId: v.id },
            include: { currentVersion: true },
          });
          await this.changed(tx, result, false);
          return { ref: { id: d.id }, data: view(result), status: 201 };
        }
        await tx.$queryRaw`SELECT id FROM knowledge_documents WHERE organization_id=${org}::uuid AND id=${id}::uuid FOR UPDATE`;
        const d = await this.document(tx, org, id!, true);
        const current = d.currentVersion!;
        if (expected !== undefined && d.version !== expected)
          fail(409, 'STALE_VERSION', '知识已更新，请刷新后重试');
        if (versionId && versionId !== d.currentVersionId)
          fail(409, 'STALE_VERSION', '只能操作当前知识版本');
        if (operation === 'prepare') {
          this.configured(current);
          if (
            current.preparationStatus === 'failed' ||
            (current.preparationStatus === 'pending' &&
              current.preparationAttempt === 0)
          ) {
            const v = await tx.knowledgeVersion.update({
              where: { id: current.id },
              data: {
                preparationStatus: 'pending',
                preparationAttempt: { increment: 1 },
                lastErrorCode: null,
                leaseToken: null,
                leaseExpiresAt: null,
                preparationStartedAt: null,
                preparationDeadlineAt: null,
                preparedAt: null,
              },
            });
            await recordOutbox(
              tx,
              org,
              'knowledge_version',
              v.id,
              v.preparationAttempt,
              'knowledge.prepare.requested',
              { versionId: v.id },
              'queue',
            );
            const next = await tx.knowledgeDocument.update({
              where: { id: d.id },
              data: { version: { increment: 1 } },
              include: { currentVersion: true },
            });
            await this.changed(tx, next, false);
          }
          const v = await tx.knowledgeVersion.findUniqueOrThrow({
            where: { id: current.id },
          });
          return {
            ref: { id: d.id, versionId: v.id },
            data: {
              versionId: v.id,
              preparationStatus: metadata(v).preparationStatus,
              preparationRequested: true,
            },
            status: 202,
          };
        }
        if (operation === 'enable') {
          if (current.preparationStatus !== 'ready')
            fail(409, 'KNOWLEDGE_NOT_READY', '知识尚未准备完成');
          this.configured(current);
        }
        if (operation === 'delete' && d.status !== 'disabled')
          fail(409, 'KNOWLEDGE_MUST_BE_DISABLED', '请先停用知识');
        const target =
          operation === 'edit'
            ? 'draft'
            : operation === 'enable'
              ? 'enabled'
              : 'disabled';
        if (['enable', 'disable'].includes(operation) && d.status === target)
          return { ref: { id: d.id }, data: view(d) };
        const nextVersion =
          operation === 'edit'
            ? await this.newVersion(
                tx,
                org,
                d.id,
                actor!,
                current.revision + 1,
                d.type,
                input,
              )
            : null;
        const next = await tx.knowledgeDocument.update({
          where: { id: d.id },
          data: {
            status: target,
            version: { increment: 1 },
            ...(nextVersion ? { currentVersionId: nextVersion.id } : {}),
            ...(operation === 'delete' ? { deletedAt: new Date() } : {}),
          },
          include: { currentVersion: true },
        });
        await this.changed(tx, next, true);
        return {
          ref: { id: d.id },
          ...(operation === 'delete' ? { status: 204 } : { data: view(next) }),
        };
      },
    );
  }
}
