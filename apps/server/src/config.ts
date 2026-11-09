import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '../../../.env'), quiet: true });

export function port(value: string | undefined, fallback: number): number {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1 || result > 65535) {
    throw new Error('API_PORT 必须为 1—65535 的整数');
  }
  return result;
}

export function settings() {
  return {
    port: port(process.env.API_PORT, 3101),
    host: process.env.API_HOST ?? '127.0.0.1',
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://smartdesk:smartdesk_local@127.0.0.1:55432/smartdesk',
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:56379',
    aiUrl: process.env.AI_SERVICE_URL ?? 'http://127.0.0.1:8100',
  };
}

export function realtimeSettings() {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} 超出范围`);
    return value;
  };
  const enabled = process.env.OUTBOX_ENABLED ?? 'true';
  if (!['true', 'false'].includes(enabled))
    throw new Error('OUTBOX_ENABLED 无效');
  return {
    enabled: enabled === 'true',
    pollMs: integer('OUTBOX_POLL_MS', 250, 25, 10000),
    leaseMs: integer('OUTBOX_LEASE_MS', 30000, 500, 120000),
  };
}
