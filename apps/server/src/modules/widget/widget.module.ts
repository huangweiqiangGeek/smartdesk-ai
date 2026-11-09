import { All, Controller, Inject, Module, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityModule } from '../identity/identity.module';
import { type IdentityRequest } from '../identity/identity.service';
import { ApiError, fail } from '../identity/input';
import { WidgetService } from './widget.service';
type Request = IncomingMessage & { originalUrl: string; body: unknown };
type Response = ServerResponse & {
  status(code: number): Response;
  json(value: unknown): void;
};
@Controller('api/v1')
class WidgetController {
  constructor(@Inject(WidgetService) private readonly widget: WidgetService) {}
  @All([
    'widget-config',
    'public/widgets/:publicKey',
    'public/widgets/:publicKey/bootstrap',
    'customers/:id',
  ])
  async handle(@Req() req: Request, @Res() res: Response) {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.originalUrl, 'http://internal');
      const r: IdentityRequest = {
        requestId,
        method: req.method ?? 'GET',
        path: url.pathname.slice(7),
        body: req.body,
        headers: req.headers,
        query: url.searchParams,
        ip: req.socket.remoteAddress ?? 'unknown',
      };
      let result: { data?: unknown; status?: number };
      const publicMatch = /^\/public\/widgets\/([^/]+)(\/bootstrap)?$/.exec(
        r.path,
      );
      if (publicMatch) {
        const w = await this.widget.publicConfig(
          publicMatch[1]!,
          typeof req.headers.origin === 'string' ? req.headers.origin : '',
        );
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin!);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Idempotency-Key',
        );
        if (r.method === 'OPTIONS') {
          res.status(204).end();
          return;
        }
        if (publicMatch[2] && r.method === 'POST')
          result = await this.widget.bootstrap(r, w);
        else if (!publicMatch[2] && r.method === 'GET')
          result = { data: this.widget.view(w) };
        else return fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
      } else if (r.path === '/widget-config')
        result = await this.widget.config(r);
      else if (r.method === 'PATCH')
        result = await this.widget.updateCustomer(r, r.path.split('/')[2]!);
      else return fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
      res.status(result.status ?? 200).json({ data: result.data, requestId });
    } catch (error) {
      const failure =
        error instanceof ApiError
          ? error
          : new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用');
      res.status(failure.status).json({
        error: { code: failure.code, message: failure.message },
        requestId,
      });
    }
  }
}
@Module({
  imports: [IdentityModule],
  controllers: [WidgetController],
  providers: [WidgetService],
  exports: [WidgetService],
})
export class WidgetModule {}
