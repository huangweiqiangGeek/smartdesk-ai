import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversations/conversation.module';
import { IdentityModule } from '../identity/identity.module';
import { RealtimeService } from './realtime.service';
@Module({
  imports: [ConversationModule, IdentityModule],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
