import {
  All,
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  HttpException,
  Inject,
  Module,
  Req,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityService } from './identity.service';
import { PresenceService } from './presence.service';
import { ConversationStateService } from '../conversations/conversation-state.service';
import { ApiError } from './input';
type Request = IncomingMessage & { originalUrl: string; body: unknown };
type Response = ServerResponse & {
  status(code: number): Response;
  json(body: unknown): void;
};
// Body-parser errors occur before the controller; preserve the public error envelope.
@Catch(HttpException)
export class ApiHttpExceptionFilter implements ExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    if (!request.originalUrl.startsWith('/api/v1/')) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.status(error.getStatus()).json({
      error: {
        code:
          error.getStatus() === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
        message: '请求格式无效',
      },
      requestId: randomUUID(),
    });
  }
}
@Controller('api/v1')
class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  @All([
    'auth/*path',
    'organizations',
    'organizations/*path',
    'memberships',
    'memberships/*path',
    'presence',
    'presence/heartbeat',
    'invitations',
    'invitations/*path',
  ])
  async handle(@Req() req: Request, @Res() res: Response) {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.originalUrl, 'http://internal');
      const result = await this.identity.handle({
        requestId,
        method: req.method ?? 'GET',
        path: url.pathname.slice('/api/v1'.length),
        query: url.searchParams,
        body: req.body,
        headers: req.headers,
        ip: req.socket.remoteAddress ?? 'unknown',
      });
      if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
      res.status(result.status ?? 200);
      if (result.status === 204) res.end();
      else res.json({ data: result.data, requestId });
    } catch (error) {
      const duplicate =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'P2002';
      const failure =
        error instanceof ApiError
          ? error
          : new ApiError(
              duplicate ? 409 : 503,
              duplicate
                ? req.originalUrl === '/api/v1/auth/register'
                  ? 'EMAIL_EXISTS'
                  : 'CONFLICT'
                : 'SERVICE_UNAVAILABLE',
              duplicate ? '记录已存在' : '服务暂时不可用',
            );
      res.status(failure.status).json({
        error: { code: failure.code, message: failure.message },
        requestId,
      });
    }
  }
}
@Module({
  controllers: [IdentityController],
  providers: [IdentityService, PresenceService, ConversationStateService],
  exports: [IdentityService, PresenceService, ConversationStateService],
})
export class IdentityModule {}
