import { All, Controller, Inject, Module, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityModule } from '../identity/identity.module';
import { ApiError } from '../identity/input';
import { KnowledgeService } from './knowledge.service';
type Request = IncomingMessage & { originalUrl: string; body: unknown };
type Response = ServerResponse & {
  status(code: number): Response;
  json(value: unknown): void;
};
@Controller('api/v1')
class KnowledgeController {
  constructor(
    @Inject(KnowledgeService) private readonly service: KnowledgeService,
  ) {}
  @All([
    'knowledge',
    'knowledge/:id',
    'knowledge/:id/versions',
    'knowledge/:id/prepare',
    'knowledge/:id/enable',
    'knowledge/:id/disable',
  ])
  async handle(@Req() req: Request, @Res() res: Response) {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.originalUrl, 'http://internal');
      const result = await this.service.handle({
        requestId,
        method: req.method ?? 'GET',
        path: url.pathname.slice(7),
        body: req.body,
        headers: req.headers,
        query: url.searchParams,
        ip: req.socket.remoteAddress ?? 'unknown',
      });
      if (result.status === 204) {
        res.status(204).end();
        return;
      }
      res.status(result.status ?? 200).json({ data: result.data, requestId });
    } catch (error) {
      const e =
        error instanceof ApiError
          ? error
          : new ApiError(
              503,
              'SERVICE_UNAVAILABLE',
              '服务暂时不可用，请使用原请求标识重试',
            );
      res
        .status(e.status)
        .json({ error: { code: e.code, message: e.message }, requestId });
    }
  }
}
@Module({
  imports: [IdentityModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
})
export class KnowledgeModule {}
