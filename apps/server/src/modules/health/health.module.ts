import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { settings } from '../../config';
import { checkAi, checkDatabase, checkRedis } from './dependencies';
import { readiness } from './readiness';

@Injectable()
export class HealthService {
  async ready() {
    const config = settings();
    const [database, redis, ai] = await Promise.all([
      checkDatabase(config.databaseUrl),
      checkRedis(config.redisUrl),
      checkAi(config.aiUrl),
    ]);
    return readiness({ database, redis, ai });
  }
}

@Controller('health')
class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  live() {
    return { service: 'api', status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const result = await this.health.ready();
    if (result.status === 'not_ready')
      throw new ServiceUnavailableException(result);
    return result;
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
