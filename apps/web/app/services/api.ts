import type { ApiEnvelope } from '@smartdesk/shared';

export type Identity =
  | {
      kind: 'member';
      userId: string;
      organizationId: string;
      membershipId: string;
    }
  | { kind: 'visitor'; customerId: string; publicKey: string; token: string };
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  organizationId?: string;
  commandId?: string;
  signal?: AbortSignal;
}
export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function staleContext() {
  return new ClientError('STALE_CONTEXT', '身份或连接已变化，请重新操作');
}

/** One HTTP implementation for member and iframe callers; credentials never enter URLs. */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
  identity: Identity | null = null,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<T> {
  if (
    identity?.kind === 'member' &&
    options.organizationId &&
    options.organizationId !== identity.organizationId
  )
    throw staleContext();
  const headers: Record<string, string> = { 'X-Requested-With': 'SmartDesk' };
  if (identity?.kind === 'visitor') {
    headers.Authorization = `Bearer ${identity.token}`;
  } else {
    const organizationId =
      options.organizationId ??
      (identity?.kind === 'member' ? identity.organizationId : undefined);
    if (organizationId) headers['X-Organization-Id'] = organizationId;
  }
  if (options.commandId) headers['Idempotency-Key'] = options.commandId;
  if (options.body) headers['Content-Type'] = 'application/json';
  const timeout = AbortSignal.timeout(10000);
  try {
    const response = await fetcher(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      credentials: identity?.kind === 'visitor' ? 'omit' : 'same-origin',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });
    if (response.status === 204) return undefined as T;
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new ClientError(
        typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
        response.status < 500 && typeof error.message === 'string'
          ? error.message
          : '服务暂时不可用，请重试',
        response.status,
        error.details,
      );
    }
    if (!isRecord(value) || !('data' in value))
      throw new ClientError('INVALID_RESPONSE', '响应格式无效，请重试');
    return (value as unknown as ApiEnvelope<T>).data;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    if (options.signal?.aborted) throw staleContext();
    throw new ClientError(
      'NETWORK_UNKNOWN',
      '连接中断或超时，保存结果尚未确认',
    );
  }
}

export function sender(identity: Identity) {
  return identity.kind === 'member'
    ? { senderType: 'agent' as const, senderId: identity.membershipId }
    : { senderType: 'visitor' as const, senderId: identity.customerId };
}
