import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { AppConfigModule } from '../config/config.module';
import { ClientsModule } from '../clients/clients.module';

@Module({
  imports: [AppConfigModule, ClientsModule],
  providers: [SessionService, ConversationMemoryService],
  exports: [SessionService, ConversationMemoryService],
})
export class SessionModule {}
