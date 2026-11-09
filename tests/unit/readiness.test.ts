import { describe, expect, it } from 'vitest';
import { readiness } from '../../apps/server/src/modules/health/readiness';
import { port } from '../../apps/server/src/config';

describe('就绪裁决', () => {
  it('数据库故障时不能就绪，即使其他依赖可用', () => {
    expect(
      readiness({
        database: 'unavailable',
        redis: 'available',
        ai: 'available',
      }).status,
    ).toBe('not_ready');
  });
  it.each(['unavailable', 'disabled', 'fake'] as const)(
    'AI %s 不阻断 DB 可用的 API，但明确降级',
    (ai) => {
      expect(
        readiness({ database: 'available', redis: 'unavailable', ai }).status,
      ).toBe('degraded');
    },
  );
  it('全部真实依赖可用才为 ready', () => {
    expect(
      readiness({ database: 'available', redis: 'available', ai: 'available' })
        .status,
    ).toBe('ready');
  });
  it.each(['', '0', '65536', '3.5', 'abc'])('拒绝非法端口 %s', (value) => {
    expect(() => port(value, 3101)).toThrow();
  });
});
