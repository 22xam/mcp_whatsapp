// Fix TLS certificate issues on Windows with Node.js native fetch
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { runStartupSelector } from './startup-selector';
import { LogBufferService } from './modules/api/log-buffer.service';

async function bootstrap() {
  const startupMode = await runStartupSelector();
  if (startupMode === 'mcp') {
    return;
  }

  // Create the app normally; LogBufferService is injected via DI into the controller.
  // We also set it as the Nest logger so every LOG/ERROR/WARN/DEBUG line is captured.
  const app = await NestFactory.create(AppModule);
  const logSvc = app.get(LogBufferService);
  app.useLogger(logSvc);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  new Logger('Bootstrap').log(`**** BOT-Oscar is running on port ${port} ***`);
}
bootstrap();
