import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { DatabaseService } from './database.service';

@Global()
@Module({
  providers: [DatabaseService, AuditService],
  exports: [DatabaseService, AuditService],
})
export class DataModule {}
