import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { settings } from './config';
import { AppModule } from './app.module';
import { ApiHttpExceptionFilter } from './modules/identity/identity.module';
import { RealtimeService } from './modules/realtime/realtime.service';

async function main() {
  const app = await NestFactory.create(AppModule);
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
