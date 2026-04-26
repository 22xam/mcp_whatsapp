// Fix TLS certificate issues on Windows with Node.js native fetch
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`****BugMate is running on port ${port}***`);
}
bootstrap();
