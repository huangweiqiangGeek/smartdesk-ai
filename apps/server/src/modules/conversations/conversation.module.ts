import { All, Controller, Inject, Module, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityModule } from '../identity/identity.module';
import { type IdentityRequest } from '../identity/identity.service';
import { WidgetModule } from '../widget/widget.module';
import { ApiError, fail } from '../identity/input';
import { ConversationService } from './conversation.service';
type Request = IncomingMessage & { originalUrl: string; body: unknown };
type Response = ServerResponse & {
  status(code: number): Response;
  json(value: unknown): void;
};
@Controller('api/v1')
class ConversationController {
  constructor(
    @Inject(ConversationService) private readonly service: ConversationService,
  ) {}
  @All([
    'conversations',
    'conversations/:id',
    'conversations/:id/messages',
    'conversations/:id/message-requests/:clientMessageId',
    'conversations/:id/handoff',
    'conversations/:id/claim',
    'conversations/:id/assign',
    'conversations/:id/transfer',
    'conversations/:id/close',
    'conversations/:id/reopen',
    'conversations/:id/read',
    'conversations/:id/events',
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
      const parts = r.path.split('/');
      let result: { data: unknown; status?: number };
      if (parts.length === 2 && r.method === 'POST')
        result = await this.service.create(r);
      else if (parts.length === 2 && r.method === 'GET')
        result = await this.service.list(r);
      else if (parts.length === 3 && r.method === 'GET')
        result = await this.service.detail(r, parts[2]!);
      else if (parts[3] === 'messages' && r.method === 'POST')
        result = await this.service.send(r, parts[2]!);
      else if (parts[3] === 'messages' && r.method === 'GET')
        result = await this.service.history(r, parts[2]!);
      else if (parts[3] === 'message-requests' && r.method === 'GET')
        result = await this.service.requestResult(r, parts[2]!, parts[4]!);
      else if (parts[3] === 'read' && r.method === 'POST')
        result = await this.service.markRead(r, parts[2]!);
      else if (parts[3] === 'events' && r.method === 'GET')
        result = await this.service.events(r, parts[2]!);
      else if (
        ['handoff', 'claim', 'assign', 'transfer', 'close', 'reopen'].includes(
          parts[3]!,
        ) &&
        r.method === 'POST'
      )
        result = await this.service.command(r, parts[2]!, parts[3]!);
      else return fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
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
  imports: [IdentityModule, WidgetModule],
  controllers: [ConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
