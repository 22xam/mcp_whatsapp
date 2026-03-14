import { Module } from '@nestjs/common';
import { TrelloService } from './trello.service';
import { AppConfigModule } from '../config/config.module';

@Module({
  imports: [AppConfigModule],
  providers: [TrelloService],
  exports: [TrelloService],
})
export class TrelloModule {}
