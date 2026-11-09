import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { PrismaClient, OutboxEvent } from '../../generated/prisma/client';
import { settings } from '../../config';

export const socketEvents = new Set([
  'message.created',
  'conversation.updated',
  'ticket.updated',
  'ai.task.updated',
  'knowledge.updated',
  'membership.updated',
  'presence.updated',
]);

/** Leases fence publication bookkeeping; transport may be repeated after an ambiguous failure. */
export class Outbox {
  constructor(
    private readonly db: PrismaClient,
    private readonly leaseMs: number,
  ) {}
  async claim(destination: 'socket' | 'queue') {
    const token = randomUUID();
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE outbox_events SET lease_token=${token}::uuid,
        lease_expires_at=clock_timestamp()+${this.leaseMs}*interval '1 millisecond',
        attempt_count=attempt_count+1, updated_at=clock_timestamp()
      WHERE id IN (SELECT id FROM outbox_events WHERE destination=${destination}
        AND status='pending' AND available_at<=clock_timestamp()
        AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
        ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 20)
      RETURNING id`;
    return this.db.outboxEvent.findMany({
      where: { id: { in: rows.map((r) => r.id) }, leaseToken: token },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  async finish(event: OutboxEvent, published: boolean) {
    const backoff = Math.min(30000, 250 * 2 ** Math.min(event.attemptCount, 7));
    return this.db.$executeRaw`UPDATE outbox_events SET
      status=CASE WHEN ${published} THEN 'published' ELSE 'pending' END,
      published_at=CASE WHEN ${published} THEN clock_timestamp() ELSE NULL END,
      available_at=CASE WHEN ${published} THEN available_at ELSE clock_timestamp()+${backoff}*interval '1 millisecond' END,
      lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=${event.id}::uuid AND status='pending' AND lease_token=${event.leaseToken}::uuid AND lease_expires_at>clock_timestamp()`;
  }
  async drain(
    destination: 'socket' | 'queue',
    publish: (event: OutboxEvent) => Promise<void>,
  ) {
    const events = await this.claim(destination);
    // A bounded batch prevents sequential recipient authorization from starving fresh messages.
    // Event order is deliberately not a contract; clients recover using seq/version.
    for (let i = 0; i < events.length; i += 4) {
      const results = await Promise.allSettled(
        events.slice(i, i + 4).map(async (event) => {
          try {
            await publish(event);
            await this.finish(event, true);
          } catch {
            await this.finish(event, false);
            console.warn(
              JSON.stringify({
                eventId: event.id,
                type: event.eventType,
                code: 'OUTBOX_RETRY',
              }),
            );
          }
        }),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    return events.length === 20;
  }
}

/** Produces real durable jobs without consuming unfinished AI business tasks. */
export class TaskPublisher {
  readonly queue: Queue;
  constructor(private readonly db: PrismaClient) {
    this.queue = new Queue('ai-tasks', {
      prefix: 'smartdesk',
      connection: {
        url: settings().redisUrl,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1000,
        commandTimeout: 2000,
      },
      defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
    });
    this.queue.on('error', () => undefined); // Outbox retains the retryable failure; no credentials in logs.
  }
  async publish(event: OutboxEvent) {
    if (
      event.eventType !== 'ai.task.requested' ||
      event.aggregateType !== 'ai_task'
    )
      throw new Error('UNSUPPORTED_EVENT');
    const task = await this.db.aiTask.findFirst({
      where: { id: event.aggregateId, organizationId: event.organizationId },
    });
    if (!task) throw new Error('TASK_NOT_FOUND');
    if (
      task.status !== 'queued' ||
      (task.deadlineAt && task.deadlineAt <= new Date())
    )
      return;
    await this.queue.add(
      'ai.task.requested',
      { taskId: task.id },
      { jobId: task.id },
    );
  }
  async close() {
    await this.queue.close();
  }
}
