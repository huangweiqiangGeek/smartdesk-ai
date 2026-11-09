import { Client } from 'pg';
import { createClient } from 'redis';
import type { DependencyState } from '@smartdesk/shared';

export async function checkDatabase(
  url: string,
  verifyVector = false,
): Promise<DependencyState> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
    statement_timeout: 1500,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('SELECT 1');
    if (verifyVector) {
      const extension = await client.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      if (!extension.rows[0]) return 'unavailable';
      const result = await client.query<{ distance: number }>(
        "SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS distance",
      );
      if (Number(result.rows[0]?.distance) !== 0) return 'unavailable';
      console.info(
        JSON.stringify({
          dependency: 'pgvector',
          version: extension.rows[0].extversion,
        }),
      );
    }
    return 'available';
  } catch {
    return 'unavailable';
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function checkRedis(url: string): Promise<DependencyState> {
  const client = createClient({
    url,
    socket: { connectTimeout: 1500, reconnectStrategy: false },
  });
  client.on('error', () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<DependencyState> => {
        await client.connect();
        return (await client.ping()) === 'PONG' ? 'available' : 'unavailable';
      })(),
      new Promise<DependencyState>((resolve) => {
        timer = setTimeout(() => resolve('unavailable'), 2000);
      }),
    ]);
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
    if (client.isOpen) client.destroy();
  }
}

export async function checkAi(url: string): Promise<DependencyState> {
  try {
    const response = await fetch(new URL('/health/ready', url), {
      signal: AbortSignal.timeout(1500),
    });
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('mode' in body))
      return 'unavailable';
    if (body.mode === 'disabled') return 'disabled';
    if (body.mode === 'fake') return 'fake';
    // T01 不把已配置或 HTTP 200 视为真实推理已验证。
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}
