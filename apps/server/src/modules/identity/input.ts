export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
export function object(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(422, 'INVALID_INPUT', '请求必须为对象');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key)))
    return fail(422, 'INVALID_INPUT', '存在不支持的字段');
  return result;
}
export function text(value: unknown, min = 1, max = 100) {
  if (
    typeof value !== 'string' ||
    [...value].length < min ||
    [...value].length > max
  )
    return fail(422, 'INVALID_INPUT', '字段长度或类型无效');
  return value;
}
export function uuid(value: unknown) {
  const id = text(value, 36, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    return fail(422, 'INVALID_INPUT', 'ID格式无效');
  return id;
}
export function choice(value: unknown, options: string[]) {
  if (typeof value !== 'string' || !options.includes(value))
    return fail(422, 'INVALID_INPUT', '字段取值无效');
  return value;
}
export function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    return fail(422, 'INVALID_INPUT', '需要有效版本');
  return Number(value);
}
export function timezone(value: unknown) {
  const zone = text(value ?? 'Asia/Shanghai');
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: zone });
  } catch {
    return fail(422, 'INVALID_INPUT', '时区无效');
  }
  return zone;
}
