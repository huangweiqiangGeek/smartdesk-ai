import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { settings } from './config';
import { AppModule } from './app.module';
import { ApiHttpExceptionFilter } from './modules/identity/identity.module';
import { RealtimeService } from './modules/realtime/realtime.service';

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Knowledge permits 50,000 code points, including JSON-escaped astral characters.
  app.useBodyParser('json', { limit: '1mb' });
  app.useGlobalFilters(new ApiHttpExceptionFilter());
  app.enableShutdownHooks();
  const config = settings();
  app.get(RealtimeService).attach(app.getHttpServer());
  await app.listen(config.port, config.host);
}
void main().catch(() => {
  console.error('API 启动失败');
  process.exitCode = 1;
});
