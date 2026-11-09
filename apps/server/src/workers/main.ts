import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthModule, HealthService } from '../modules/health/health.module';

@Module({ imports: [HealthModule] })
class WorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const result = await app.get(HealthService).ready();
  console.info(JSON.stringify({ ...result, service: 'worker', consumers: 0 }));
  if (process.argv.includes('--check')) {
    await app.close();
    process.exitCode =
      result.dependencies.database === 'available' &&
      result.dependencies.redis === 'available'
        ? 0
        : 1;
    return;
  }
  // T01 仅保留独立进程；队列与业务消费者在对应任务实现。
  const keepAlive = setInterval(() => undefined, 60_000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    await app.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
}
void main().catch(() => {
  console.error('worker 启动失败');
  process.exitCode = 1;
});
