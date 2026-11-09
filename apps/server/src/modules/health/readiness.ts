import type { Readiness } from '@smartdesk/shared';

export function readiness(
  dependencies: Readiness['dependencies'],
  service: Readiness['service'] = 'api',
): Readiness {
  return {
    service,
    status:
      dependencies.database !== 'available'
        ? 'not_ready'
        : Object.values(dependencies).every((state) => state === 'available')
          ? 'ready'
          : 'degraded',
    dependencies,
  };
}
