import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessagePage } from '@smartdesk/shared';
import {
  apiRequest,
  ClientError,
  type Identity,
} from '../../apps/web/app/services/api';
import { MessageWindow } from '../../apps/web/app/services/message-state';
import { SupportClient } from '../../apps/web/app/services/support-client';
import type { SocketTransport } from '../../apps/web/app/services/socket';

const actor: Identity = {
  kind: 'visitor',
  customerId: 'customer',
  publicKey: 'site',
  token: 'secret',
};
const member: Identity = {
  kind: 'member',
  userId: 'u',
  organizationId: 'o',
  membershipId: 'm',
};
const message = (seq: number, changes: Partial<Message> = {}): Message => ({
  id: `m-${seq}`,
  conversationId: 'c',
  senderId: 'customer',
  senderType: 'visitor',
  clientMessageId: `request-${seq}`,
  seq,
  content: '允许重复文字',
  createdAt: '2026-11-07T00:00:00Z',
  conversationVersion: seq,
  ...changes,
});
const latest = (through = 0): MessagePage => ({
  items: Array.from({ length: Math.min(50, through) }, (_, i) =>
    message(Math.max(1, through - 49) + i),
  ),
  mode: 'latest',
  snapshotThroughSeq: through,
  windowStartSeq: through ? Math.max(1, through - 49) : null,
  nextCursor: through > 50 ? 'older' : null,
  hasMore: through > 50,
});
const after = (items: Message[], through: number): MessagePage => ({
  items,
  mode: 'after',
  snapshotThroughSeq: through,
  windowStartSeq: items[0]?.seq ?? null,
  nextCursor: null,
  hasMore: false,
});
const response = (data: unknown) =>
  new Response(JSON.stringify({ data, requestId: 'r' }), { status: 200 });
const failure = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: code } }), { status });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 35; i++) await Promise.resolve();
};
class FakeSocket implements SocketTransport {
  connected = false;
  handlers = new Map<string, (...args: unknown[]) => void>();
  captured: ((...args: unknown[]) => void)[] = [];
  invoke = vi.fn(
    async (event: string, body: Record<string, unknown>): Promise<unknown> => ({
      ok: true,
      data:
        event === 'conversation.subscribe'
          ? { snapshotThroughSeq: 0, conversationVersion: 0 }
          : body,
    }),
  );
  on(event: string, listener: (...args: unknown[]) => void) {
    this.handlers.set(event, listener);
    this.captured.push(listener);
  }
  off() {
    this.handlers.clear();
  }
  connect() {}
  disconnect() {
    this.connected = false;
  }
  request(event: string, body: Record<string, unknown>) {
    return this.invoke(event, body);
  }
  event(event: string, data?: unknown) {
    this.handlers.get(event)?.(data);
  }
  online() {
    this.connected = true;
    this.event('connect');
  }
  offline() {
    this.connected = false;
    this.event('disconnect', 'transport close');
  }
  push(m: Message) {
    this.event('message.created', {
      eventId: m.id,
      type: 'message.created',
      occurredAt: m.createdAt,
      data: m,
    });
  }
}
const clients: SupportClient[] = [];
function setup(fetcher: typeof fetch, socket = new FakeSocket()) {
  const factory = vi.fn(() => socket);
  const client = new SupportClient('', {
    fetcher,
    socketFactory: factory,
    uuid: () => 'new-id',
  });
  clients.push(client);
  client.setIdentity(actor);
  socket.event('connect_error', new Error('test HTTP fallback'));
  return { client, socket, factory };
}
afterEach(() => {
  for (const c of clients) c.destroy();
  clients.length = 0;
  vi.useRealTimers();
});

describe('member presence lifecycle', () => {
  it('registers HTTP without Socket, serializes heartbeats and pauses when hidden', async () => {
    vi.useFakeTimers();
    const held = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(response({}));
    const { client } = setup(fetcher);
    client.setIdentity(member);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/v1/presence/heartbeat');
    await vi.advanceTimersByTimeAsync(31000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.setVisible(false);
    held.resolve(response({}));
    await settle();
    await vi.advanceTimersByTimeAsync(31000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.setVisible(true);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.destroy();
    await vi.advanceTimersByTimeAsync(31000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('isolates late heartbeat completion across organization changes and only uses the registered Socket ID', async () => {
    vi.useFakeTimers();
    const held = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(response({}));
    const { client, socket } = setup(fetcher);
    client.setIdentity(member);
    client.setIdentity({ ...member, organizationId: 'next' });
    await settle();
    held.resolve(failure(401, 'UNAUTHENTICATED'));
    await settle();
    expect(client.snapshot().connection).not.toBe('expired');
    socket.online();
    socket.event('presence.registered', { connectionId: 'bound-id' });
    await settle();
    expect(socket.invoke).toHaveBeenCalledWith('presence.heartbeat', {
      connectionId: 'bound-id',
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(
      socket.invoke.mock.calls.filter(
        ([event]) => event === 'presence.heartbeat',
      ),
    ).toHaveLength(2);
    client.setIdentity(null);
    await vi.advanceTimersByTimeAsync(30000);
    expect(
      socket.invoke.mock.calls.filter(
        ([event]) => event === 'presence.heartbeat',
      ),
    ).toHaveLength(2);
  });
});

describe('message windows', () => {
  it('keeps the latest 50 baseline separate from older history and fills holes in order', () => {
    const w = new MessageWindow('c');
    w.merge(message(72));
    w.initialize(latest(70));
    expect(w.lastContiguousSeq).toBe(70);
    w.merge(message(71));
    expect(w.lastContiguousSeq).toBe(72);
    w.older({ ...latest(20), mode: 'before', snapshotThroughSeq: 70 });
    expect(w.lastContiguousSeq).toBe(72);
    expect(w.messages()).toHaveLength(72);
  });
  it('does not deduplicate identical text or another sender clientMessageId', () => {
    const w = new MessageWindow('c');
    w.initialize(latest());
    w.pending.set('same', {
      id: null,
      conversationId: 'c',
      clientMessageId: 'same',
      senderId: 'customer',
      senderType: 'visitor',
      content: 'same text',
      status: 'pending',
      error: null,
    });
    w.merge(message(1, { clientMessageId: 'same', senderId: 'another' }));
    expect(w.pending.size).toBe(1);
    w.merge(message(2, { clientMessageId: 'same' }));
    w.merge(message(2, { clientMessageId: 'same' }));
    expect(w.pending.size).toBe(0);
    expect(w.messages()).toHaveLength(2);
  });
  it('refuses an incomplete initial window instead of skipping its missing seq', () => {
    const w = new MessageWindow('c');
    const p = latest(70);
    p.items.splice(10, 1);
    expect(() => w.initialize(p)).toThrow('历史窗口不完整');
    expect(w.lastContiguousSeq).toBe(0);
  });
});

describe('HTTP contract', () => {
  it('separates cookie and Bearer credentials and preserves structured failures', async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({}));
    await apiRequest(
      '/x',
      { method: 'POST', body: {}, organizationId: 'forged', commandId: 'k' },
      actor,
      f,
    );
    const options = f.mock.calls[0]![1]!;
    expect(options.credentials).toBe('omit');
    expect(options.headers).not.toHaveProperty('X-Organization-Id');
    expect(options.headers).toHaveProperty('Authorization', 'Bearer secret');
    await apiRequest('/x', {}, member, f);
    expect(f.mock.calls[1]![1]?.credentials).toBe('same-origin');
    expect(f.mock.calls[1]![1]?.headers).not.toHaveProperty('Authorization');
    f.mockResolvedValue(failure(409, 'STALE_VERSION'));
    await expect(apiRequest('/x', {}, null, f)).rejects.toMatchObject({
      code: 'STALE_VERSION',
      status: 409,
    });
  });
});

describe('connection and recovery', () => {
  it('buffers events while subscribing, uses the frozen latest watermark, then fills a gap', async () => {
    const initial = deferred<Response>(),
      queries: string[] = [];
    const { client, socket } = setup(
      vi.fn(async (path) => {
        const url = String(path);
        queries.push(url);
        return url.includes('afterSeq')
          ? response(after([message(71), message(72)], 72))
          : initial.promise;
      }),
    );
    socket.invoke.mockImplementation(async () => ({
      ok: true,
      data: { snapshotThroughSeq: 70, conversationVersion: 70 },
    }));
    socket.online();
    client.openConversation('c');
    await settle();
    socket.push(message(72));
    expect(queries[0]).toContain('throughSeq=70');
    initial.resolve(response(latest(70)));
    await settle();
    expect(queries.some((q) => q.includes('afterSeq=70'))).toBe(true);
    expect(client.snapshot().lastContiguousSeq).toBe(72);
    expect(client.snapshot().messages).toHaveLength(52);
  });
  it('uses only one HTTP recovery loop, pauses hidden polling, and stops it on reconnect', async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    let count = 0;
    const f = vi.fn(async () =>
      ++count === 1 ? pending.promise : response(after([], 0)),
    );
    const { client, socket } = setup(f);
    client.openConversation('c');
    client.recoverNow();
    client.recoverNow();
    await vi.advanceTimersByTimeAsync(12000);
    expect(count).toBe(1);
    pending.resolve(response(latest()));
    await settle();
    expect(count).toBe(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(count).toBe(3);
    client.setVisible(false);
    await vi.advanceTimersByTimeAsync(15000);
    expect(count).toBe(3);
    client.setVisible(true);
    await settle();
    socket.online();
    await settle();
    const onlineCount = count;
    await vi.advanceTimersByTimeAsync(15000);
    expect(count).toBe(onlineCount);
  });
  it('keeps older history independent from realtime recovery', async () => {
    const old = deferred<Response>();
    const f = vi.fn(async (path) =>
      String(path).includes('beforeSeq')
        ? old.promise
        : String(path).includes('afterSeq')
          ? response(after([message(71)], 71))
          : response(latest(70)),
    );
    const { client, socket } = setup(f);
    client.openConversation('c');
    await settle();
    const loading = client.loadOlder();
    socket.push(message(72));
    await settle();
    old.resolve(
      response({ ...latest(20), mode: 'before', snapshotThroughSeq: 70 }),
    );
    await loading;
    expect(client.snapshot().lastContiguousSeq).toBe(72);
    expect(client.snapshot().messages).toHaveLength(72);
  });
  it('destroys old listeners and rejects late HTTP, events, and subscription ACK after identity change', async () => {
    const request = deferred<Response>();
    const sockets: FakeSocket[] = [];
    const client = new SupportClient('', {
      fetcher: () => request.promise,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    clients.push(client);
    client.setIdentity(member);
    sockets[0]!.online();
    client.openConversation('c');
    client.setDraft('私密草稿');
    await settle();
    const late = sockets[0]!.handlers.get('message.created')!;
    client.setIdentity({
      ...member,
      organizationId: 'other',
      membershipId: 'other-m',
    });
    request.resolve(response(latest(1)));
    late({ type: 'message.created', data: message(2) });
    await settle();
    expect(sockets[0]!.handlers.size).toBe(0);
    expect(sockets[0]!.connected).toBe(false);
    expect(client.snapshot().messages).toHaveLength(0);
    expect(client.snapshot().draft.text).toBe('');
    client.setIdentity(null);
    expect(sockets[1]!.handlers.size).toBe(0);
  });
  it('ignores an obsolete reconnect snapshot and re-subscribes', async () => {
    const ack = deferred<unknown>();
    let count = 0;
    const { client, socket } = setup(
      vi.fn(async (path) =>
        String(path).includes('afterSeq')
          ? response(after([], 0))
          : response(latest()),
      ),
    );
    socket.invoke.mockImplementation(async () =>
      ++count === 1
        ? ack.promise
        : { ok: true, data: { snapshotThroughSeq: 0, conversationVersion: 0 } },
    );
    socket.online();
    client.openConversation('c');
    await settle();
    socket.offline();
    socket.online();
    ack.resolve({
      ok: true,
      data: { snapshotThroughSeq: 999, conversationVersion: 999 },
    });
    await settle();
    expect(count).toBe(2);
    expect(client.snapshot().lastContiguousSeq).toBe(0);
    expect(client.snapshot().loading).toBe(false);
  });
  it('clears an invalid identity and unsubscribes once for the final page consumer', async () => {
    const { client, socket, factory } = setup(
      vi.fn(async (path) =>
        String(path).includes('/auth')
          ? failure(401, 'UNAUTHENTICATED')
          : response(latest()),
      ),
    );
    client.setIdentity(actor);
    expect(factory).toHaveBeenCalledTimes(1);
    socket.online();
    const a = client.openConversation('c'),
      b = client.openConversation('c');
    await settle();
    a();
    expect(client.snapshot().conversationId).toBe('c');
    b();
    b();
    await settle();
    expect(
      socket.invoke.mock.calls.filter(
        (c) => c[0] === 'conversation.unsubscribe',
      ),
    ).toHaveLength(1);
    await expect(client.request('/auth/me')).rejects.toBeInstanceOf(
      ClientError,
    );
    expect(client.snapshot().connection).toBe('expired');
    expect(socket.handlers.size).toBe(0);
  });
});

describe('send and drafts', () => {
  it('rejects an enterprise override instead of mixing it into the active identity', async () => {
    const fetcher = vi.fn();
    await expect(
      apiRequest(
        '/conversations',
        { organizationId: 'another' },
        member,
        fetcher,
      ),
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('replaces the connection when an unsubscribe acknowledgement is unknown', async () => {
    const { client, socket } = setup(vi.fn(async () => response(latest())));
    socket.online();
    const release = client.openConversation('c');
    await settle();
    const reconnect = vi
      .spyOn(socket, 'connect')
      .mockImplementation(() => socket.online());
    vi.spyOn(socket, 'disconnect').mockImplementation(() => socket.offline());
    socket.invoke.mockImplementation(async (event) => {
      if (event === 'conversation.unsubscribe') throw new Error('lost ACK');
      return {
        ok: true,
        data: { snapshotThroughSeq: 0, conversationVersion: 0 },
      };
    });
    release();
    client.openConversation('c');
    await settle();
    expect(reconnect).toHaveBeenCalledOnce();
    expect(client.snapshot().loading).toBe(false);
    expect(client.snapshot().connection).toBe('socket');
  });
  it('waits for the old unsubscribe before re-opening the same conversation', async () => {
    const leave = deferred<unknown>();
    const { client, socket } = setup(vi.fn(async () => response(latest())));
    socket.online();
    const release = client.openConversation('c');
    await settle();
    socket.invoke.mockImplementation(async (event) =>
      event === 'conversation.unsubscribe'
        ? leave.promise
        : { ok: true, data: { snapshotThroughSeq: 0, conversationVersion: 0 } },
    );
    const count = () =>
      socket.invoke.mock.calls.filter((c) => c[0] === 'conversation.subscribe')
        .length;
    release();
    client.openConversation('c');
    await settle();
    expect(count()).toBe(1);
    leave.resolve({ ok: true, data: {} });
    await settle();
    expect(count()).toBe(2);
    expect(client.snapshot().loading).toBe(false);
  });
  it('waits for a connecting socket before choosing HTTP fallback', async () => {
    const f = vi.fn(async () => response(latest()));
    const socket = new FakeSocket();
    const client = new SupportClient('', {
      fetcher: f,
      socketFactory: () => socket,
    });
    clients.push(client);
    client.setIdentity(actor);
    client.openConversation('c');
    await settle();
    expect(f).not.toHaveBeenCalled();
    socket.online();
    await settle();
    expect(socket.invoke.mock.calls[0]?.[0]).toBe('conversation.subscribe');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('keeps newly typed text after a delayed successful send and drops late ACK on logout', async () => {
    const ack = deferred<unknown>();
    const { client, socket } = setup(vi.fn(async () => response(latest())));
    socket.online();
    client.openConversation('c');
    await settle();
    socket.invoke.mockImplementation(() => ack.promise);
    client.setDraft('已点击发送');
    client.send('已点击发送', 'id');
    client.setDraft('正在输入下一条');
    ack.resolve({
      ok: true,
      data: message(1, { clientMessageId: 'id', content: '已点击发送' }),
    });
    await settle();
    expect(client.snapshot().draft.text).toBe('正在输入下一条');
    const late = deferred<unknown>();
    socket.invoke.mockImplementation(() => late.promise);
    client.send('迟到', 'late');
    client.setIdentity(null);
    late.resolve({ ok: true, data: message(2, { clientMessageId: 'late' }) });
    await settle();
    expect(client.snapshot().messages).toHaveLength(0);
  });
  it('merges broadcast before ACK and never downgrades sent for a late rejection', async () => {
    const ack = deferred<unknown>();
    const { client, socket } = setup(vi.fn(async () => response(latest())));
    socket.online();
    client.openConversation('c');
    await settle();
    socket.invoke.mockImplementation(() => ack.promise);
    client.send('same', 'id');
    socket.push(message(1, { clientMessageId: 'id', content: 'same' }));
    ack.resolve({
      ok: false,
      error: { code: 'CONVERSATION_CLOSED', message: 'closed' },
    });
    await settle();
    expect(client.snapshot().messages).toHaveLength(1);
    expect(client.snapshot().messages[0]?.status).toBe('sent');
  });
  it('queries after ACK timeout and retries HTTP with exactly the same ID only when not found', async () => {
    const f = vi.fn(async (path, options) => {
      if (String(path).includes('message-requests'))
        return failure(404, 'REQUEST_NOT_FOUND');
      if (options?.method === 'POST')
        return response(message(1, JSON.parse(String(options.body))));
      return response(latest());
    });
    const { client, socket } = setup(f);
    socket.online();
    client.openConversation('c');
    await settle();
    socket.invoke.mockRejectedValue(new Error('ACK timeout'));
    client.send('同文', 'stable');
    client.retry('stable');
    await settle();
    const posts = f.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body)).clientMessageId).toBe(
      'stable',
    );
    expect(client.snapshot().messages[0]?.status).toBe('sent');
  });
  it('keeps an unknown result pending and a definitive refusal failed', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(response(latest()));
    const { client } = setup(f);
    client.openConversation('c');
    await settle();
    f.mockRejectedValue(new Error('offline'));
    client.send('uncertain', 'p');
    await settle();
    expect(client.snapshot().messages[0]?.status).toBe('pending');
    f.mockResolvedValue(failure(409, 'CONVERSATION_CLOSED'));
    client.send('rejected', 'f');
    await settle();
    expect(
      client.snapshot().messages.find((m) => m.clientMessageId === 'f')?.status,
    ).toBe('failed');
  });
  it('does not overwrite manual drafts with events or outdated explicit suggestions', async () => {
    const { client, socket } = setup(vi.fn(async () => response(latest())));
    client.openConversation('c');
    await settle();
    client.setDraft('原草稿');
    const s = client.snapshot();
    client.setDraft('人工修改');
    socket.push(message(1));
    expect(
      client.applySuggestion('旧建议', {
        contextGeneration: s.contextGeneration,
        conversationId: 'c',
        draftRevision: s.draft.revision,
        inputRevision: s.lastContiguousSeq,
      }),
    ).toBe(false);
    expect(client.snapshot().draft.text).toBe('人工修改');
    client.openConversation('other');
    expect(client.snapshot().draft.text).toBe('');
    client.openConversation('c');
    expect(client.snapshot().draft.text).toBe('人工修改');
    client.setIdentity(member);
    expect(client.snapshot().draft.text).toBe('');
  });
});
