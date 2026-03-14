import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { ConditionalFlowService } from './conditional-flow.service';
import { ValidateService } from './validate.service';
import { AiModule } from '../ai/ai.module';
import { AppConfigModule } from '../config/config.module';
import { SessionModule } from '../session/session.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TrelloModule } from '../trello/trello.module';

@Module({
  imports: [AiModule, AppConfigModule, SessionModule, KnowledgeModule, TrelloModule],
  providers: [BotService, ConditionalFlowService, ValidateService],
  exports: [BotService],
})
export class BotModule {}
