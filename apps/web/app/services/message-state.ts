import type { Message, MessagePage } from '@smartdesk/shared';
import { ClientError, isRecord } from './api';

export type DisplayMessage =
  | (Message & { status: 'sent' })
  | {
      id: null;
      conversationId: string;
      clientMessageId: string;
      senderId: string;
      senderType: 'agent' | 'visitor';
      content: string;
      status: 'pending' | 'failed';
      error: string | null;
    };
export function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    [
      'id',
      'conversationId',
      'senderId',
      'clientMessageId',
      'content',
      'createdAt',
    ].every((k) => typeof value[k] === 'string') &&
    ['visitor', 'agent', 'ai', 'system'].includes(String(value.senderType)) &&
    Number.isSafeInteger(value.seq) &&
    Number(value.seq) > 0 &&
    Number.isSafeInteger(value.conversationVersion) &&
    Number(value.conversationVersion) >= 0
  );
}
export function isMessagePage(value: unknown): value is MessagePage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isMessage) &&
    ['latest', 'before', 'after'].includes(String(value.mode)) &&
    Number.isSafeInteger(value.snapshotThroughSeq) &&
    Number(value.snapshotThroughSeq) >= 0 &&
    (value.windowStartSeq === null ||
      Number.isSafeInteger(value.windowStartSeq)) &&
    (value.nextCursor === null || typeof value.nextCursor === 'string') &&
    typeof value.hasMore === 'boolean'
  );
}
const sameRequest = (
  a: Pick<Message, 'senderType' | 'senderId' | 'clientMessageId'>,
  b: Pick<Message, 'senderType' | 'senderId' | 'clientMessageId'>,
) =>
  a.senderType === b.senderType &&
  a.senderId === b.senderId &&
  a.clientMessageId === b.clientMessageId;

/** Earlier unloaded history is a separate interval; only a verified latest window sets the baseline. */
export class MessageWindow {
  readonly saved = new Map<string, Message>();
  readonly pending = new Map<string, Exclude<DisplayMessage, Message>>();
  initialized = false;
  lastContiguousSeq = 0;
  targetThrough = 0;
  historyBefore: number | null = null;
  historyThrough = 0;
  hasOlder = false;
  conversationVersion = 0;
  private readonly seqs = new Map<number, string>();

  constructor(readonly conversationId: string) {}
  merge(message: Message) {
    if (message.conversationId !== this.conversationId) return;
    const prior = this.seqs.get(message.seq);
    if (prior && prior !== message.id)
      throw new ClientError('INVALID_RESPONSE', '消息序号冲突，请重新加载');
    this.saved.set(message.id, message);
    this.seqs.set(message.seq, message.id);
    const local = this.pending.get(message.clientMessageId);
    if (local && sameRequest(local, message))
      this.pending.delete(message.clientMessageId);
    this.targetThrough = Math.max(this.targetThrough, message.seq);
    this.conversationVersion = Math.max(
      this.conversationVersion,
      message.conversationVersion,
    );
    this.advance();
  }
  initialize(page: MessagePage) {
    const through = page.snapshotThroughSeq;
    const start = Math.max(1, through - 49);
    if (
      page.mode !== 'latest' ||
      page.items.length !== Math.min(50, through) ||
      page.items.some(
        (m, i) =>
          m.conversationId !== this.conversationId || m.seq !== start + i,
      )
    )
      throw new ClientError('INCOMPLETE_WINDOW', '历史窗口不完整，请重试');
    this.historyThrough = through;
    this.historyBefore = page.windowStartSeq;
    this.hasOlder = page.hasMore;
    this.lastContiguousSeq = through === 0 ? 0 : start - 1;
    this.initialized = true;
    for (const message of page.items) this.merge(message);
    this.targetThrough = Math.max(this.targetThrough, through);
    this.advance();
  }
  older(page: MessagePage) {
    for (const message of page.items) this.merge(message);
    this.historyBefore = page.windowStartSeq ?? this.historyBefore;
    this.hasOlder = page.hasMore;
  }
  private advance() {
    if (!this.initialized) return;
    while (this.seqs.has(this.lastContiguousSeq + 1)) this.lastContiguousSeq++;
  }
  confirmed(
    clientMessageId: string,
    actor: ReturnType<typeof import('./api').sender>,
  ) {
    return [...this.saved.values()].find((m) =>
      sameRequest(m, { ...actor, clientMessageId }),
    );
  }
  messages(): DisplayMessage[] {
    return [
      ...[...this.saved.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((m) => ({ ...m, status: 'sent' as const })),
      ...[...this.pending.values()].map((m) => ({ ...m })),
    ];
  }
}
