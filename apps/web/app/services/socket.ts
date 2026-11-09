import { io } from 'socket.io-client';
import type { Identity } from './api';

export interface SocketTransport {
  readonly connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(): void;
  connect(): void;
  disconnect(): void;
  request(event: string, body: Record<string, unknown>): Promise<unknown>;
}

/** A dedicated Manager keeps identity changes out of Socket.IO's shared connection cache. */
export function createSocket(
  base: string,
  identity: Identity,
): SocketTransport {
  const socket = io(`${base.replace(/\/$/, '')}/support`, {
    autoConnect: false,
    forceNew: true,
    withCredentials: identity.kind === 'member',
    auth:
      identity.kind === 'member'
        ? { organizationId: identity.organizationId }
        : { visitorToken: identity.token },
  });
  return {
    get connected() {
      return socket.connected;
    },
    on: (event, listener) => {
      socket.on(event, listener);
    },
    off: () => {
      socket.removeAllListeners();
    },
    connect: () => {
      socket.connect();
    },
    disconnect: () => {
      socket.disconnect();
    },
    request: (event, body) =>
      new Promise((resolve, reject) => {
        if (!socket.connected) {
          reject(new Error('disconnected'));
          return;
        }
        // No offline send buffer or retry queue: HTTP recovery owns stable-ID retries.
        socket.volatile
          .timeout(5000)
          .emit(event, body, (error: Error | null, ack: unknown) => {
            if (error) reject(error);
            else resolve(ack);
          });
      }),
  };
}
