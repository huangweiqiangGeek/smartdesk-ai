import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { WidgetModule } from './modules/widget/widget.module';
import { ConversationModule } from './modules/conversations/conversation.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
@Module({
  imports: [
    HealthModule,
    IdentityModule,
    WidgetModule,
    ConversationModule,
    RealtimeModule,
    KnowledgeModule,
  ],
})
export class AppModule {}
