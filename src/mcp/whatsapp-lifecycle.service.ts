import type { Client } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import type { McpLogger } from './mcp-logger.js';
import type { WhatsAppClientFactory } from './whatsapp-client.factory.js';
import type {
  WhatsAppClientProvider,
  WhatsAppConnectionState,
} from './whatsapp-tool-runner.js';

export class WhatsAppLifecycleService implements WhatsAppClientProvider {
  private client: Client;
  private ready = false;
  private readyAt: number | null = null;

  constructor(
    private readonly clientFactory: WhatsAppClientFactory,
    private readonly logger: McpLogger,
  ) {
    this.client = this.clientFactory.create();
  }

  getClient(): Client {
    return this.client;
  }

  getState(): WhatsAppConnectionState {
    return {
      ready: this.ready,
      readyAt: this.readyAt,
    };
  }

  registerEvents(): void {
    this.client.on('qr', (qr) => {
      this.logger.log('QR received', { length: qr.length });
      process.stderr.write('\n[MCP] Escanea el QR con tu telefono:\n');
      qrcode.generate(qr, { small: true }, (code) =>
        process.stderr.write(code + '\n'),
      );
    });

    this.client.on('authenticated', () => {
      this.logger.log('WhatsApp authenticated');
      process.stderr.write('[MCP] WhatsApp autenticado\n');
    });

    this.client.on('ready', () => {
      this.ready = true;
      this.readyAt = Date.now();
      this.logger.log('WhatsApp ready');
      process.stderr.write('[MCP] WhatsApp listo - MCP server operativo\n');
      process.stderr.write(
        '[MCP] Ya podes cerrar la ventana del QR/Chrome si quedo abierta. Deja esta consola abierta mientras uses el MCP.\n',
      );
    });

    this.client.on('disconnected', (reason) => {
      this.ready = false;
      this.logger.log('WhatsApp disconnected', { reason });
      process.stderr.write(`[MCP] WhatsApp desconectado: ${reason}\n`);
    });

    this.client.on('auth_failure', (message) => {
      this.logger.log('WhatsApp auth failure', { message });
      process.stderr.write(`[MCP] Fallo de autenticacion: ${message}\n`);
    });

    this.client.on('loading_screen', (percent, message) => {
      this.logger.log('WhatsApp loading screen', { percent, message });
    });

    this.client.on('change_state', (state) => {
      this.logger.log('WhatsApp state changed', { state });
    });
  }

  async initializeWithRetry(maxAttempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.ready = false;
        this.readyAt = null;
        this.logger.log('Initializing WhatsApp client', {
          attempt,
          maxAttempts,
        });
        await this.client.initialize();
        this.logger.log('WhatsApp initialize returned', { attempt });
        return;
      } catch (error) {
        const err = error as Error;
        const browserProfileLocked =
          /browser is already running|Use a different `userDataDir`/i.test(
            err.message,
          );
        const retryable =
          browserProfileLocked ||
          /Execution context was destroyed|Target closed|Protocol error|Navigation/i.test(
            err.message,
          );

        this.logger.log('WhatsApp initialize failed', {
          attempt,
          maxAttempts,
          retryable,
          error: err.message,
          stack: err.stack,
        });

        if (!retryable || attempt === maxAttempts) throw err;

        if (browserProfileLocked) {
          await this.cleanupBrowserProcesses();
        }

        await this.destroyAfterFailure();
        await new Promise((resolve) => setTimeout(resolve, 2000));

        this.client = this.clientFactory.create();
        this.registerEvents();
      }
    }
  }

  private async destroyAfterFailure(): Promise<void> {
    try {
      await this.client.destroy();
    } catch (error) {
      this.logger.log('WhatsApp destroy after failed initialize failed', {
        error: (error as Error).message,
      });
    }
  }

  private async cleanupBrowserProcesses(): Promise<void> {
    if (!this.clientFactory.cleanupBrowserProcesses) {
      this.logger.log(
        'No browser cleanup hook configured for WhatsApp client factory',
      );
      return;
    }

    const killedCount = await this.clientFactory.cleanupBrowserProcesses();
    this.logger.log('WhatsApp browser cleanup hook completed', { killedCount });
  }
}
