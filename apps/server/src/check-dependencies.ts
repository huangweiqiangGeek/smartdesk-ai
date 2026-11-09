import { settings } from './config';
import { checkDatabase, checkRedis } from './modules/health/dependencies';

async function main() {
  const config = settings();
  const [postgresWithVector, redis] = await Promise.all([
    checkDatabase(config.databaseUrl, true),
    checkRedis(config.redisUrl),
  ]);
  console.info(JSON.stringify({ postgresWithVector, redis }));
  process.exitCode =
    postgresWithVector === 'available' && redis === 'available' ? 0 : 1;
}
void main().catch(() => {
  console.error('依赖检查失败');
  process.exitCode = 1;
});
