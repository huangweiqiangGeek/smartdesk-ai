import type {
  Message,
  MessagePage,
  SubscriptionSnapshot,
} from '@smartdesk/shared';
import {
  apiRequest,
  ClientError,
  isRecord,
  sender,
  staleContext,
  type Identity,
  type RequestOptions,
} from './api';
import {
  isMessage,
  isMessagePage,
  MessageWindow,
  type DisplayMessage,
} from './message-state';
import { createSocket, type SocketTransport } from './socket';

type Draft = { text: string; revision: number };
type Chat = {
  id: string;
  window: MessageWindow;
  refs: number;
  subscribedAt: number;
  loading: boolean;
  historyLoading: boolean;
  error: string | null;
  historyError: string | null;
  status: string | null;
  statusVersion: number;
};
export interface SupportSnapshot {
  contextGeneration: number;
  connectionGeneration: number;
  connection: 'idle' | 'connecting' | 'socket' | 'http' | 'expired';
  conversationId: string | null;
  messages: DisplayMessage[];
  lastContiguousSeq: number;
  hasOlder: boolean;
  loading: boolean;
  historyLoading: boolean;
  error: string | null;
  historyError: string | null;
  conversationVersion: number;
  conversationStatus: string | null;
  draft: Readonly<Draft>;
}
interface Dependencies {
  fetcher?: typeof fetch;
  socketFactory?: (identity: Identity) => SocketTransport;
  uuid?: () => string;
}
const unauthorized = (error: ClientError) =>
  error.status === 401 ||
  [
    'UNAUTHENTICATED',
    'INVALID_VISITOR_TOKEN',
    'SESSION_EXPIRED',
    'MEMBERSHIP_INACTIVE',
  ].includes(error.code);
const definite = (error: ClientError) =>
  (error.status >= 400 && error.status < 500) ||
  [
    'CONVERSATION_CLOSED',
    'NOT_ASSIGNEE',
    'IDEMPOTENCY_CONFLICT',
    'INVALID_INPUT',
    'FORBIDDEN',
    'NOT_FOUND',
    'RATE_LIMITED',
  ].includes(error.code);

/** One instance per browser app; no identity, token, message or draft is kept in an SSR singleton. */
export class SupportClient {
  private identity: Identity | null = null;
  private socket: SocketTransport | null = null;
  private chat: Chat | null = null;
  private drafts = new Map<string, Draft>();
  private listeners = new Set<(state: SupportSnapshot) => void>();
  private requests = new Set<AbortController>();
  private sends = new Map<string, Promise<void>>();
  private subscriptions: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private presencePending = false;
  private httpPresenceId: string | null = null;
  private socketPresenceId: string | null = null;
  private recovering: {
    chat: Chat;
    abort: AbortController;
    connection: number;
  } | null = null;
  private dirty = false;
  private visible = true;
  private contextGeneration = 0;
  private connectionGeneration = 0;
  private connection: SupportSnapshot['connection'] = 'idle';
  private readonly fetcher: typeof fetch;
  private readonly socketFactory: (identity: Identity) => SocketTransport;
  private readonly uuid: () => string;

  constructor(socketBase: string, dependencies: Dependencies = {}) {
    this.fetcher = dependencies.fetcher ?? globalThis.fetch;
    this.socketFactory =
      dependencies.socketFactory ??
      ((identity) => createSocket(socketBase, identity));
    this.uuid = dependencies.uuid ?? (() => globalThis.crypto.randomUUID());
  }
  snapshot(): SupportSnapshot {
    const chat = this.chat;
    return {
      contextGeneration: this.contextGeneration,
      connectionGeneration: this.connectionGeneration,
      connection: this.connection,
      conversationId: chat?.id ?? null,
      messages: chat?.window.messages() ?? [],
      lastContiguousSeq: chat?.window.lastContiguousSeq ?? 0,
      hasOlder: chat?.window.hasOlder ?? false,
      loading: chat?.loading ?? false,
      historyLoading: chat?.historyLoading ?? false,
      error: chat?.error ?? null,
      historyError: chat?.historyError ?? null,
      conversationVersion: chat?.window.conversationVersion ?? 0,
      conversationStatus: chat?.status ?? null,
      draft: {
        ...((chat ? this.drafts.get(chat.id) : undefined) ?? {
          text: '',
          revision: 0,
        }),
      },
    };
  }
  listen(listener: (state: SupportSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
  setIdentity(identity: Identity | null) {
    if (JSON.stringify(identity) === JSON.stringify(this.identity)) return;
    this.clear();
    this.identity = identity ? { ...identity } : null;
    if (identity?.kind === 'member')
      this.httpPresenceId = globalThis.crypto.randomUUID();
    if (!identity) {
      this.changed();
      return;
    }
    this.connection = 'connecting';
    const socket = this.socketFactory(identity);
    this.socket = socket;
    const generation = this.contextGeneration;
    const current = () =>
      this.contextGeneration === generation && this.socket === socket;
    socket.on('connect', () => {
      if (!current()) return;
      this.connectionGeneration++;
      this.connection = 'socket';
      this.cancelTimer();
      this.recovering?.abort.abort();
      this.schedule();
      this.changed();
    });
    socket.on('presence.registered', (value) => {
      if (
        !current() ||
        !isRecord(value) ||
        typeof value.connectionId !== 'string'
      )
        return;
      this.socketPresenceId = value.connectionId;
      this.heartbeat();
    });
    socket.on('disconnect', (reason) => {
      if (!current()) return;
      this.socketPresenceId = null;
      if (reason === 'io server disconnect') {
        this.expire();
        return;
      }
      this.connectionGeneration++;
      this.connection = 'http';
      this.recovering?.abort.abort();
      this.schedule();
      this.changed();
    });
    socket.on('connect_error', (value) => {
      if (!current()) return;
      const data = isRecord(value) && isRecord(value.data) ? value.data : null;
      if (data && typeof data.code === 'string') {
        // Server handshake rejection is an identity boundary, not an endless network retry.
        this.expire();
        return;
      }
      this.connection = 'http';
      this.schedule();
      this.changed();
    });
    socket.on('message.created', (value) => {
      if (
        !current() ||
        !isRecord(value) ||
        value.type !== 'message.created' ||
        !isMessage(value.data)
      )
        return;
      const chat = this.chat;
      if (!chat || chat.id !== value.data.conversationId) return;
      try {
        chat.window.merge(value.data);
      } catch (error) {
        chat.error = (error as Error).message;
      }
      if (chat.window.lastContiguousSeq < chat.window.targetThrough)
        this.schedule();
      this.changed();
    });
    socket.on('conversation.updated', (value) => {
      if (
        !current() ||
        !isRecord(value) ||
        value.type !== 'conversation.updated' ||
        !isRecord(value.data)
      )
        return;
      const chat = this.chat,
        data = value.data;
      if (
        !chat ||
        data.id !== chat.id ||
        !Number.isSafeInteger(data.version) ||
        Number(data.version) <= chat.statusVersion
      )
        return;
      chat.statusVersion = Number(data.version);
      chat.window.conversationVersion = Math.max(
        chat.window.conversationVersion,
        Number(data.version),
      );
      if (typeof data.status === 'string') chat.status = data.status;
      if (Number.isSafeInteger(data.lastSeq)) {
        chat.window.targetThrough = Math.max(
          chat.window.targetThrough,
          Number(data.lastSeq),
        );
        if (chat.window.lastContiguousSeq < chat.window.targetThrough)
          this.schedule();
      }
      this.changed();
    });
    socket.connect();
    this.heartbeat();
    this.changed();
  }
  /** A visible member page registers over HTTP even when Socket has never connected. */
  private heartbeat() {
    if (
      !this.visible ||
      this.identity?.kind !== 'member' ||
      this.presencePending
    )
      return;
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    this.presencePending = true;
    const generation = this.contextGeneration;
    const work =
      this.socket?.connected && this.socketPresenceId
        ? this.rpc('presence.heartbeat', {
            connectionId: this.socketPresenceId,
          })
        : this.request('/presence/heartbeat', {
            method: 'POST',
            body: { connectionId: this.httpPresenceId },
          });
    void work
      .catch((error) => {
        if (generation !== this.contextGeneration) return;
        if (
          error instanceof ClientError &&
          [401, 403, 404].includes(error.status)
        )
          this.expire();
      })
      .finally(() => {
        if (generation !== this.contextGeneration) return;
        this.presencePending = false;
        if (this.visible && this.identity?.kind === 'member')
          this.presenceTimer = setTimeout(() => this.heartbeat(), 15000);
      });
  }
  /** Abort first, then drop references; even a non-cancellable late promise cannot mutate the next identity. */
  private clear() {
    this.contextGeneration++;
    this.connectionGeneration++;
    this.cancelTimer();
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    this.presencePending = false;
    this.httpPresenceId = null;
    this.socketPresenceId = null;
    for (const request of this.requests) request.abort();
    this.recovering?.abort.abort();
    this.socket?.off();
    this.socket?.disconnect();
    this.socket = null;
    this.identity = null;
    this.chat = null;
    this.recovering = null;
    this.dirty = false;
    this.drafts.clear();
    this.sends.clear();
    this.subscriptions = Promise.resolve();
    this.connection = 'idle';
  }
  private expire() {
    this.clear();
    this.connection = 'expired';
    this.changed();
  }
  destroy() {
    this.clear();
    this.changed();
    this.listeners.clear();
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible && this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = undefined;
    }
    if (visible) this.heartbeat();
    if (!visible) this.cancelTimer();
    else if (
      this.chat &&
      this.connection !== 'idle' &&
      this.connection !== 'expired'
    )
      this.schedule();
  }
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const generation = this.contextGeneration,
      controller = new AbortController();
    this.requests.add(controller);
    try {
      const result = await apiRequest<T>(
        path,
        {
          ...options,
          signal: options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal,
        },
        this.identity,
        this.fetcher,
      );
      if (generation !== this.contextGeneration) throw staleContext();
      return result;
    } catch (error) {
      if (generation !== this.contextGeneration) throw staleContext();
      if (error instanceof ClientError && unauthorized(error) && this.identity)
        this.expire();
      throw error;
    } finally {
      this.requests.delete(controller);
    }
  }
  openConversation(id: string) {
    if (!this.identity)
      throw new ClientError('UNAUTHENTICATED', '请先建立身份', 401);
    if (this.chat?.id !== id) {
      this.closeConversation();
      this.chat = {
        id,
        window: new MessageWindow(id),
        refs: 0,
        subscribedAt: -1,
        loading: true,
        historyLoading: false,
        error: null,
        historyError: null,
        status: null,
        statusVersion: -1,
      };
    }
    const chat = this.chat!;
    chat.refs++;
    this.schedule();
    this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.chat === chat && --chat.refs === 0) this.closeConversation();
    };
  }
  private closeConversation() {
    const chat = this.chat;
    this.chat = null;
    this.dirty = false;
    this.cancelTimer();
    this.recovering?.abort.abort();
    if (chat && this.socket?.connected)
      void this.subscription('conversation.unsubscribe', chat.id).catch(
        () => {},
      );
    this.changed();
  }
  private subscription(event: string, conversationId: string) {
    const socket = this.socket,
      context = this.contextGeneration,
      connection = this.connectionGeneration;
    const current = () =>
      this.socket === socket &&
      this.contextGeneration === context &&
      this.connectionGeneration === connection;
    const operation = this.subscriptions.then(async () => {
      if (!current()) throw staleContext();
      try {
        return await this.rpc<SubscriptionSnapshot>(event, { conversationId });
      } catch (error) {
        // An unacknowledged unsubscribe could otherwise remove a later subscription.
        // A new connection isolates any late operation still running on the server.
        if (current() && socket?.connected) {
          socket.disconnect();
          socket.connect();
        }
        throw error;
      }
    });
    this.subscriptions = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  setDraft(text: string) {
    if (!this.chat) return;
    const old = this.drafts.get(this.chat.id);
    this.drafts.set(this.chat.id, { text, revision: (old?.revision ?? 0) + 1 });
    this.changed();
  }
  applySuggestion(
    text: string,
    expected: {
      contextGeneration: number;
      conversationId: string;
      draftRevision: number;
      inputRevision: number;
    },
  ) {
    const state = this.snapshot();
    if (
      expected.contextGeneration !== state.contextGeneration ||
      expected.conversationId !== state.conversationId ||
      expected.draftRevision !== state.draft.revision ||
      expected.inputRevision !== state.lastContiguousSeq ||
      this.chat!.window.targetThrough !== state.lastContiguousSeq
    )
      return false;
    this.setDraft(text);
    return true;
  }
  private async rpc<T>(
    event: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const socket = this.socket,
      context = this.contextGeneration,
      connection = this.connectionGeneration;
    if (!socket?.connected)
      throw new ClientError('NETWORK_UNKNOWN', '实时连接不可用');
    let value: unknown;
    try {
      value = await socket.request(event, body);
    } catch {
      throw new ClientError('ACK_UNKNOWN', '确认超时，保存结果尚未确认');
    }
    if (
      this.socket !== socket ||
      context !== this.contextGeneration ||
      connection !== this.connectionGeneration
    )
      throw staleContext();
    if (!isRecord(value) || typeof value.ok !== 'boolean')
      throw new ClientError('INVALID_RESPONSE', '确认格式无效');
    if (!value.ok) {
      const error = isRecord(value.error) ? value.error : {};
      const result = new ClientError(
        String(error.code ?? 'REQUEST_FAILED'),
        typeof error.message === 'string' ? error.message : '请求未完成',
      );
      if (unauthorized(result)) this.expire();
      throw result;
    }
    return value.data as T;
  }
  private cancelTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule() {
    if (!this.chat || !this.identity || !this.visible) return;
    if (this.connection === 'connecting' && !this.socket?.connected) return;
    this.dirty = true;
    this.cancelTimer();
    if (!this.recovering) void this.recover();
  }
  private async page(chat: Chat, query: URLSearchParams, signal?: AbortSignal) {
    const data = await this.request<unknown>(
      `/conversations/${chat.id}/messages?${query}`,
      { signal },
    );
    if (
      !isMessagePage(data) ||
      data.items.some((m) => m.conversationId !== chat.id)
    )
      throw new ClientError('INVALID_RESPONSE', '历史响应无效，请重试');
    return data;
  }
  /** All gap/reconnect/poll requests join this one serial driver; history paging has a separate cursor. */
  private async recover() {
    const chat = this.chat;
    if (!chat || !this.identity || this.recovering) return;
    const job = {
      chat,
      abort: new AbortController(),
      connection: this.connectionGeneration,
    };
    const generation = this.contextGeneration;
    this.recovering = job;
    this.dirty = false;
    const valid = () =>
      this.chat === chat &&
      this.contextGeneration === generation &&
      this.connectionGeneration === job.connection &&
      !job.abort.signal.aborted;
    const check = () => {
      if (!valid()) throw staleContext();
    };
    try {
      let through: number | undefined;
      if (this.socket?.connected && chat.subscribedAt !== job.connection) {
        const snapshot = await this.subscription(
          'conversation.subscribe',
          chat.id,
        );
        check();
        if (
          !Number.isSafeInteger(snapshot?.snapshotThroughSeq) ||
          snapshot.snapshotThroughSeq < 0
        )
          throw new ClientError('INVALID_RESPONSE', '订阅水位无效');
        chat.subscribedAt = job.connection;
        through = snapshot.snapshotThroughSeq;
        chat.window.conversationVersion = Math.max(
          chat.window.conversationVersion,
          snapshot.conversationVersion,
        );
      }
      if (!chat.window.initialized) {
        const query = new URLSearchParams({ limit: '50' });
        if (through !== undefined) query.set('throughSeq', String(through));
        const page = await this.page(chat, query, job.abort.signal);
        check();
        chat.window.initialize(page);
      } else {
        const query = new URLSearchParams({
          afterSeq: String(chat.window.lastContiguousSeq),
          limit: '50',
        });
        // A buffered event can be newer than the subscribe snapshot; never request a backwards interval.
        if (through !== undefined && through >= chat.window.lastContiguousSeq)
          query.set('throughSeq', String(through));
        let page: MessagePage;
        let cursor: string | null = null;
        do {
          const before = chat.window.lastContiguousSeq;
          page = await this.page(
            chat,
            cursor ? new URLSearchParams({ cursor, limit: '50' }) : query,
            job.abort.signal,
          );
          check();
          for (const message of page.items) chat.window.merge(message);
          chat.window.targetThrough = Math.max(
            chat.window.targetThrough,
            page.snapshotThroughSeq,
          );
          if (
            page.snapshotThroughSeq > before &&
            chat.window.lastContiguousSeq <= before
          )
            throw new ClientError(
              'INCOMPLETE_WINDOW',
              '消息存在缺口，稍后重试',
            );
          cursor = page.nextCursor;
          if (page.hasMore && !cursor)
            throw new ClientError('INVALID_RESPONSE', '缺少历史游标');
        } while (page.hasMore);
      }
      check();
      chat.error = null;
      chat.loading = false;
      if (chat.window.lastContiguousSeq < chat.window.targetThrough)
        this.dirty = true;
      // Lost acknowledgements are reconciled without automatically re-sending on every poll.
      for (const pending of chat.window.pending.values()) {
        if (
          pending.status !== 'pending' ||
          this.sends.has(pending.clientMessageId)
        )
          continue;
        try {
          const message = await this.request<unknown>(
            `/conversations/${chat.id}/message-requests/${pending.clientMessageId}`,
            { signal: job.abort.signal },
          );
          check();
          if (isMessage(message)) chat.window.merge(message);
        } catch (error) {
          check();
          if (
            !(error instanceof ClientError) ||
            error.code !== 'REQUEST_NOT_FOUND'
          )
            throw error;
        }
      }
    } catch (error) {
      if (valid()) {
        chat.loading = false;
        chat.error =
          error instanceof Error ? error.message : '恢复失败，请重试';
        if (error instanceof ClientError && [403, 404].includes(error.status)) {
          this.drafts.delete(chat.id);
          this.closeConversation();
        }
      }
    } finally {
      if (this.recovering === job) {
        this.recovering = null;
        if (this.chat && this.identity && this.visible) {
          if (this.dirty) {
            this.dirty = false;
            this.schedule();
          } else if (
            this.connection !== 'socket' ||
            this.chat.error ||
            this.chat.window.lastContiguousSeq < this.chat.window.targetThrough
          )
            this.timer = setTimeout(() => this.schedule(), 3000);
        }
        this.changed();
      }
    }
  }
  recoverNow() {
    this.schedule();
  }
  async loadOlder() {
    const chat = this.chat,
      generation = this.contextGeneration;
    if (
      !chat?.window.initialized ||
      !chat.window.hasOlder ||
      chat.historyLoading ||
      !chat.window.historyBefore
    )
      return;
    chat.historyLoading = true;
    chat.historyError = null;
    this.changed();
    try {
      const page = await this.page(
        chat,
        new URLSearchParams({
          beforeSeq: String(chat.window.historyBefore),
          throughSeq: String(chat.window.historyThrough),
          limit: '50',
        }),
      );
      if (this.chat !== chat || this.contextGeneration !== generation) return;
      chat.window.older(page);
    } catch (error) {
      if (this.chat === chat && this.contextGeneration === generation)
        chat.historyError = (error as Error).message;
    } finally {
      if (this.chat === chat && this.contextGeneration === generation) {
        chat.historyLoading = false;
        this.changed();
      }
    }
  }
  send(content: string, clientMessageId = this.uuid()) {
    const chat = this.chat,
      identity = this.identity;
    if (!chat || !identity)
      throw new ClientError('UNAUTHENTICATED', '请先打开会话', 401);
    if (!content.trim() || Array.from(content).length > 8000)
      throw new ClientError('INVALID_INPUT', '消息需为1—8000个字符', 422);
    const old = chat.window.pending.get(clientMessageId);
    if (old && old.content !== content)
      throw new ClientError(
        'IDEMPOTENCY_CONFLICT',
        '重试必须使用原消息内容',
        409,
      );
    if (chat.window.confirmed(clientMessageId, sender(identity)))
      return clientMessageId;
    if (!old)
      chat.window.pending.set(clientMessageId, {
        id: null,
        conversationId: chat.id,
        clientMessageId,
        ...sender(identity),
        content,
        status: 'pending',
        error: null,
      });
    const draft = this.drafts.get(chat.id);
    if (draft?.text === content)
      this.drafts.set(chat.id, { text: '', revision: draft.revision + 1 });
    this.retry(clientMessageId);
    this.changed();
    return clientMessageId;
  }
  retry(clientMessageId: string) {
    const chat = this.chat,
      identity = this.identity;
    const pending = chat?.window.pending.get(clientMessageId);
    if (!chat || !identity || !pending || this.sends.has(clientMessageId))
      return;
    pending.status = 'pending';
    pending.error = null;
    const generation = this.contextGeneration;
    const current = () =>
      generation === this.contextGeneration && this.chat === chat;
    const commit = (message: unknown) => {
      if (!current()) throw staleContext();
      if (
        !isMessage(message) ||
        message.conversationId !== chat.id ||
        message.clientMessageId !== clientMessageId ||
        message.senderId !== sender(identity).senderId ||
        message.senderType !== sender(identity).senderType
      )
        throw new ClientError('INVALID_RESPONSE', '消息确认无效');
      chat.window.merge(message);
      if (chat.window.lastContiguousSeq < chat.window.targetThrough)
        this.schedule();
    };
    const post = () =>
      this.request<unknown>(`/conversations/${chat.id}/messages`, {
        method: 'POST',
        body: { clientMessageId, content: pending.content },
      });
    const task = (async () => {
      try {
        try {
          commit(
            this.socket?.connected
              ? await this.rpc<Message>('message.send', {
                  conversationId: chat.id,
                  clientMessageId,
                  content: pending.content,
                })
              : await post(),
          );
        } catch (error) {
          if (!current()) return;
          if (chat.window.confirmed(clientMessageId, sender(identity))) return;
          if (error instanceof ClientError && definite(error)) throw error;
          try {
            commit(
              await this.request(
                `/conversations/${chat.id}/message-requests/${clientMessageId}`,
              ),
            );
          } catch (queryError) {
            if (!current()) return;
            if (
              queryError instanceof ClientError &&
              queryError.code === 'REQUEST_NOT_FOUND'
            )
              commit(await post());
            else throw queryError;
          }
        }
      } catch (error) {
        if (current() && chat.window.pending.has(clientMessageId)) {
          pending.status =
            error instanceof ClientError && definite(error)
              ? 'failed'
              : 'pending';
          pending.error =
            error instanceof Error ? error.message : '保存结果尚未确认';
        }
      }
    })();
    this.sends.set(clientMessageId, task);
    void task.finally(() => {
      if (this.sends.get(clientMessageId) === task)
        this.sends.delete(clientMessageId);
      if (current()) this.changed();
    });
    this.changed();
  }
}
