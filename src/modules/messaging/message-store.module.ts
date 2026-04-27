import { Global, Module } from '@nestjs/common';
import { MessageStoreService } from './message-store.service';

@Global()
@Module({
  providers: [MessageStoreService],
  exports: [MessageStoreService],
})
export class MessageStoreModule {}
