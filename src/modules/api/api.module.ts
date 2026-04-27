import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { BroadcastService } from './broadcast.service';
import { LogBufferService } from './log-buffer.service';
import { AppConfigModule } from '../config/config.module';
import { SessionModule } from '../session/session.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BotModule } from '../bot/bot.module';
import { TrelloModule } from '../trello/trello.module';
import { AiModule } from '../ai/ai.module';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [AppConfigModule, SessionModule, KnowledgeModule, BotModule, TrelloModule, AiModule, MessagingModule],
  controllers: [ApiController],
  providers: [BroadcastService, LogBufferService],
  exports: [LogBufferService],
})
export class ApiModule {}
