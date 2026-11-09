import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { ConversationService } from '../conversations/conversation.service';
import {
  IdentityService,
  type IdentityRequest,
} from '../identity/identity.service';
import { ApiError, fail, object, uuid } from '../identity/input';
import { realtimeSettings } from '../../config';
import { Outbox, socketEvents, TaskPublisher } from './outbox';
import type { SocketAck } from '@smartdesk/shared';

type Context = {
  request: IdentityRequest;
  subscriptions: Set<string>;
  organizationId: string;
  pending: number;
  buffered: number;
  connectionId: string | null;
};
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private io?: Server;
  private publisher?: TaskPublisher;
  private stopped = false;
  private timers = new Set<NodeJS.Timeout>();
  private running = new Set<Promise<void>>();
  private contexts = new Map<string, Context>();
  constructor(
    @Inject(ConversationService)
    private readonly conversations: ConversationService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  attach(server: HttpServer) {
    const widgetOrigin = process.env.WIDGET_ORIGIN ?? this.identity.origin;
    this.io = new Server(server, {
      maxHttpBufferSize: 65536,
      serveClient: false,
      cors: { origin: [this.identity.origin, widgetOrigin], credentials: true },
      allowRequest: (req, done) =>
        done(
          null,
          [this.identity.origin, widgetOrigin].includes(
            req.headers.origin ?? '',
          ) &&
            Object.keys(
              Object.fromEntries(
                new URL(req.url ?? '/', 'http://internal').searchParams,
              ),
            ).every((k) =>
              ['EIO', 'transport', 't', 'sid', 'b64', 'j'].includes(k),
            ),
        ),
    });
    const ns = this.io.of('/support');
    ns.use((socket, next) => {
      void (async () => {
        const auth = object(socket.handshake.auth, [
          'organizationId',
          'visitorToken',
        ]);
        const visitor = auth.visitorToken !== undefined;
        if (visitor && auth.organizationId !== undefined)
          fail(422, 'INVALID_INPUT', '身份不能混用');
        if (
          socket.handshake.headers.origin !==
          (visitor ? widgetOrigin : this.identity.origin)
        )
          fail(403, 'ORIGIN_NOT_ALLOWED', '连接来源无效');
        if (
          visitor &&
          (typeof auth.visitorToken !== 'string' ||
            !/^[a-f0-9]{64}$/.test(auth.visitorToken))
        )
          fail(401, 'INVALID_VISITOR_TOKEN', '访客凭据无效');
        const request: IdentityRequest = {
          requestId: randomUUID(),
          method: 'GET',
          path: '/realtime',
          body: undefined,
          query: new URLSearchParams(),
          ip: socket.handshake.address,
          headers: {
            origin: socket.handshake.headers.origin,
            ...(visitor
              ? { authorization: `Bearer ${auth.visitorToken}` }
              : {
                  cookie: socket.handshake.headers.cookie,
                  'x-organization-id': uuid(auth.organizationId).toLowerCase(),
                }),
          },
        };
        const actor = await this.conversations.realtimeIdentity(request);
        const connectionId = actor.type === 'agent' ? randomUUID() : null;
        if (connectionId)
          await this.identity.heartbeat(request, connectionId, socket.id);
        const context: Context = {
          request,
          subscriptions: new Set(),
          organizationId: actor.organizationId,
          pending: 0,
          buffered: 0,
          connectionId,
        };
        this.contexts.set(socket.id, context);
        socket.conn.on('packetCreate', () => {
          if (++context.buffered > 100) socket.disconnect(true);
        });
        socket.conn.on('drain', () => {
          context.buffered = 0;
        });
        socket.conn.once('close', () => this.disconnected(socket.id));
        // The transport may close while the asynchronous identity/heartbeat writes run.
        if (socket.conn.readyState === 'closed') {
          this.disconnected(socket.id);
          return next(new Error('连接已关闭'));
        }
        next();
      })().catch((error) => {
        const e = this.error(error);
        next(Object.assign(new Error(e.message), { data: { code: e.code } }));
      });
    });
    ns.on('connection', (socket) => {
      const context = this.contexts.get(socket.id);
      if (context?.connectionId)
        socket.emit('presence.registered', {
          connectionId: context.connectionId,
        });
      socket.on('disconnect', () => this.disconnected(socket.id));
      socket.onAny((name: string, body: unknown, callback: unknown) => {
        const context = this.contexts.get(socket.id);
        if (!context) return;
        const requestId = randomUUID();
        const ack = (value: SocketAck<unknown>) => {
          if (typeof callback === 'function') callback(value);
        };
        if (++context.pending > 16) {
          context.pending--;
          ack({
            ok: false,
            error: { code: 'RATE_LIMITED', message: '请求过于频繁' },
            requestId,
          });
          return;
        }
        void this.operation(socket, context, name, body, requestId)
          .then((data) => ack({ ok: true, data, requestId }))
          .catch((error) => {
            const e = this.error(error);
            ack({
              ok: false,
              error: { code: e.code, message: e.message },
              requestId,
            });
          })
          .finally(() => context.pending--);
      });
    });
    const config = realtimeSettings();
    if (config.enabled) {
      const outbox = new Outbox(this.identity.db, config.leaseMs);
      this.publisher = new TaskPublisher(this.identity.db);
      this.loop(config.pollMs, () =>
        outbox.drain('socket', async (event) => {
          if (!socketEvents.has(event.eventType))
            throw new Error('UNSUPPORTED_EVENT');
          for (const socket of ns.sockets.values()) {
            const context = this.contexts.get(socket.id);
            if (!context || context.organizationId !== event.organizationId)
              continue;
            try {
              const projected = await this.conversations.realtimeEvent(
                context.request,
                event,
                context.subscriptions,
              );
              if (projected && socket.connected) {
                socket.emit(projected.type, projected);
              }
            } catch (error) {
              if (!(error instanceof ApiError)) throw error;
              await this.revalidate(socket, context);
            }
          }
        }),
      );
      this.loop(config.pollMs, () =>
        outbox.drain('queue', (event) => this.publisher!.publish(event)),
      );
    }
    this.loop(1000, async () => {
      await this.identity.db.$transaction((tx) =>
        this.identity.presence.expire(tx),
      );
      for (const socket of ns.sockets.values()) {
        const context = this.contexts.get(socket.id);
        if (context) await this.revalidate(socket, context);
      }
    });
  }
  private async operation(
    socket: Socket,
    context: Context,
    name: string,
    body: unknown,
    requestId: string,
  ) {
    if (name === 'presence.heartbeat') {
      const input = object(body, ['connectionId']);
      if (!context.connectionId)
        fail(403, 'FORBIDDEN', '访客不能登记成员在线状态');
      if (uuid(input.connectionId).toLowerCase() !== context.connectionId)
        fail(403, 'CONNECTION_MISMATCH', '连接标识不属于当前连接');
      return this.identity.heartbeat(
        context.request,
        context.connectionId!,
        socket.id,
      );
    }
    if (
      ![
        'conversation.subscribe',
        'conversation.unsubscribe',
        'message.send',
      ].includes(name)
    )
      return fail(422, 'UNSUPPORTED_EVENT', '事件尚不支持');
    const input = object(
      body,
      name === 'message.send'
        ? ['conversationId', 'clientMessageId', 'content']
        : ['conversationId'],
    );
    const conversationId = uuid(input.conversationId).toLowerCase();
    const r = { ...context.request, requestId };
    if (name === 'message.send')
      return (
        await this.conversations.send(
          {
            ...r,
            method: 'POST',
            body: {
              clientMessageId: input.clientMessageId,
              content: input.content,
            },
            headers: {
              ...r.headers,
              'content-type': 'application/json',
              'x-requested-with': 'SmartDesk',
            },
          },
          conversationId,
        )
      ).data;
    await this.conversations.realtimeIdentity(r);
    if (name === 'conversation.unsubscribe') {
      context.subscriptions.delete(conversationId);
      return { conversationId };
    }
    if (
      !context.subscriptions.has(conversationId) &&
      context.subscriptions.size >= 100
    )
      return fail(429, 'SUBSCRIPTION_LIMIT', '订阅数量已达上限');
    context.subscriptions.add(conversationId);
    try {
      return await this.conversations.subscribe(r, conversationId);
    } catch (error) {
      context.subscriptions.delete(conversationId);
      throw error;
    } finally {
      if (!socket.connected) context.subscriptions.clear();
    }
  }
  private async revalidate(socket: Socket, context: Context) {
    try {
      await this.conversations.realtimeIdentity(context.request);
      for (const id of context.subscriptions) {
        try {
          await this.conversations.subscribe(context.request, id);
        } catch (error) {
          if (error instanceof ApiError) context.subscriptions.delete(id);
          else throw error;
        }
      }
    } catch {
      socket.disconnect(true);
    }
  }
  private disconnected(socketId: string) {
    const context = this.contexts.get(socketId);
    this.contexts.delete(socketId);
    if (!context?.connectionId) return;
    const task = this.identity.db
      .$transaction((tx) => this.identity.presence.disconnect(tx, socketId))
      .catch(() => {
        console.warn('连接离线标记暂时不可用，将由心跳超时收敛');
      })
      .finally(() => this.running.delete(task));
    this.running.add(task);
  }
  private error(error: unknown) {
    return error instanceof ApiError
      ? error
      : new ApiError(
          503,
          'SERVICE_UNAVAILABLE',
          '服务暂时不可用，请使用原请求标识重试',
        );
  }
  private loop(ms: number, work: () => Promise<void | boolean>) {
    const run = () => {
      if (this.stopped) return;
      let nextMs = ms;
      const task = work()
        .then((fullBatch) => {
          if (fullBatch) nextMs = 0;
        })
        .catch(() => console.warn('实时投递暂时不可用'))
        .finally(() => {
          this.running.delete(task);
          if (!this.stopped) {
            const timer = setTimeout(() => {
              this.timers.delete(timer);
              run();
            }, nextMs);
            timer.unref();
            this.timers.add(timer);
          }
        });
      this.running.add(task);
    };
    run();
  }
  async onModuleDestroy() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    await new Promise<void>((resolve) => {
      if (this.io) this.io.close(() => resolve());
      else resolve();
    });
    await Promise.allSettled(this.running);
    await this.publisher?.close();
    this.contexts.clear();
  }
}
