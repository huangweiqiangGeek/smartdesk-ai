import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MembershipView, PresenceHeartbeat } from '@smartdesk/shared';
import type { Prisma } from '../../generated/prisma/client';
import { recordOutbox } from '../conversations/conversation-state.service';
import { fail } from './input';

type Tx = Prisma.TransactionClient;
export const memberSelect = {
  id: true,
  userId: true,
  role: true,
  status: true,
  availability: true,
  readingLanguage: true,
  version: true,
  user: { select: { displayName: true } },
} as const;
type Member = Prisma.MembershipGetPayload<{ select: typeof memberSelect }>;

@Injectable()
export class PresenceService {
  private live(now = new Date()): Prisma.PresenceConnectionWhereInput {
    return {
      disconnectedAt: null,
      lastSeenAt: { gt: new Date(now.getTime() - 60000) },
      authSession: {
        revokedAt: null,
        expiresAt: { gt: now },
        user: { status: 'active' },
      },
    };
  }
  async views(
    tx: Tx,
    org: string,
    members: Member[],
  ): Promise<MembershipView[]> {
    const connections = await tx.presenceConnection.findMany({
      where: {
        organizationId: org,
        membershipId: { in: members.map((m) => m.id) },
        ...this.live(),
      },
      distinct: ['membershipId'],
      select: { membershipId: true },
    });
    const online = new Set(connections.map((c) => c.membershipId));
    return members.map(({ user, ...m }) => ({
      ...m,
      displayName: user.displayName,
      online:
        m.status === 'active' &&
        m.availability === 'available' &&
        online.has(m.id),
    }));
  }
  async available(tx: Tx, org: string, membershipId: string) {
    const m = await tx.membership.findFirst({
      where: {
        id: membershipId,
        organizationId: org,
        status: 'active',
        availability: 'available',
      },
      select: memberSelect,
    });
    return !!m && (await this.views(tx, org, [m]))[0]!.online;
  }
  async notify(tx: Tx, org: string, membershipId: string, version = 0) {
    await recordOutbox(
      tx,
      org,
      'presence',
      randomUUID(),
      version,
      'presence.updated',
      { membershipId },
    );
  }
  /** IDs bind once to session/member/org/transport. An HTTP first heartbeat needs no Socket record. */
  async heartbeat(
    tx: Tx,
    org: string,
    membershipId: string,
    sessionId: string,
    connectionId: string,
    socketId: string | null = null,
  ): Promise<PresenceHeartbeat> {
    const now = new Date(),
      transport = socketId ? 'socket' : 'http';
    const inserted = await tx.presenceConnection.createMany({
      skipDuplicates: true,
      data: {
        id: connectionId,
        organizationId: org,
        membershipId,
        authSessionId: sessionId,
        transport,
        socketId,
        lastSeenAt: now,
      },
    });
    await tx.$queryRaw`SELECT id FROM presence_connections WHERE id=${connectionId}::uuid FOR UPDATE`;
    const c = await tx.presenceConnection.findUnique({
      where: { id: connectionId },
    });
    if (
      !c ||
      c.organizationId !== org ||
      c.membershipId !== membershipId ||
      c.authSessionId !== sessionId ||
      c.transport !== transport ||
      c.socketId !== socketId
    )
      return fail(403, 'CONNECTION_MISMATCH', '连接标识不属于当前身份');
    const wasStale =
      c.disconnectedAt || c.lastSeenAt.getTime() <= now.getTime() - 60000;
    await tx.presenceConnection.update({
      where: { id: connectionId },
      data: { lastSeenAt: now, disconnectedAt: null },
    });
    if (inserted.count || wasStale) await this.notify(tx, org, membershipId);
    return {
      serverTime: now.toISOString(),
      onlineUntil: new Date(now.getTime() + 60000).toISOString(),
    };
  }
  async disconnect(tx: Tx, socketId: string) {
    const rows = await tx.presenceConnection.findMany({
      where: { socketId, disconnectedAt: null },
    });
    for (const row of rows) {
      const changed = await tx.presenceConnection.updateMany({
        where: { id: row.id, disconnectedAt: null },
        data: { disconnectedAt: new Date() },
      });
      if (changed.count)
        await this.notify(tx, row.organizationId, row.membershipId);
    }
  }
  async expire(tx: Tx) {
    const now = new Date(),
      cutoff = new Date(now.getTime() - 60000);
    const stale: Prisma.PresenceConnectionWhereInput = {
      disconnectedAt: null,
      OR: [
        { lastSeenAt: { lte: cutoff } },
        { authSession: { revokedAt: { not: null } } },
        { authSession: { expiresAt: { lte: now } } },
        { authSession: { user: { status: { not: 'active' } } } },
      ],
    };
    const rows = await tx.presenceConnection.findMany({
      where: stale,
      orderBy: { id: 'asc' },
      take: 100,
    });
    for (const row of rows) {
      const changed = await tx.presenceConnection.updateMany({
        where: { id: row.id, ...stale },
        data: { disconnectedAt: now },
      });
      if (changed.count)
        await this.notify(tx, row.organizationId, row.membershipId);
    }
  }
}
