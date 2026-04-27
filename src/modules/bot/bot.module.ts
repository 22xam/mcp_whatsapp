import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { ConditionalFlowService } from './conditional-flow.service';
import { ValidateService } from './validate.service';
import { BotControlService } from './bot-control.service';
import { AiModule } from '../ai/ai.module';
import { AppConfigModule } from '../config/config.module';
import { SessionModule } from '../session/session.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TrelloModule } from '../trello/trello.module';
import { ClientsModule } from '../clients/clients.module';

@Module({
  imports: [AiModule, AppConfigModule, SessionModule, KnowledgeModule, TrelloModule, ClientsModule],
  providers: [BotService, ConditionalFlowService, ValidateService, BotControlService],
  exports: [BotService, BotControlService],
})
export class BotModule {}
