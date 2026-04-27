/**
 * WhatsApp MCP Server.
 *
 * This file is intentionally small: it wires the MCP transport with the
 * WhatsApp lifecycle and the tool runner. Feature logic lives in focused
 * collaborators so new tools can be added without changing server startup.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FileMcpLogger, MCP_LOG_PATH, redactToolArgs, type McpLogger } from './mcp-logger.js';
import { LocalAuthWhatsAppClientFactory } from './whatsapp-client.factory.js';
import { WhatsAppLifecycleService } from './whatsapp-lifecycle.service.js';
import { WHATSAPP_TOOLS } from './whatsapp-tool-definitions.js';
import { fail, type ToolResult, WhatsAppToolRunner } from './whatsapp-tool-runner.js';

class WhatsAppMcpServer {
  private readonly server: Server;

  constructor(
    private readonly logger: McpLogger,
    private readonly lifecycle: WhatsAppLifecycleService,
    private readonly toolRunner: WhatsAppToolRunner,
  ) {
    this.server = new Server(
      { name: 'whatsapp-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  async start(): Promise<void> {
    this.logger.log('Starting WhatsApp MCP server', {
      pid: process.pid,
      node: process.version,
      logPath: MCP_LOG_PATH,
    });

    this.registerProcessDiagnostics();
    this.lifecycle.registerEvents();

    const transport = new StdioServerTransport();
    this.logger.log('Connecting stdio transport');
    await this.server.connect(transport);
    this.logger.log('Stdio transport connected');
    process.stderr.write('[MCP] Transporte stdio conectado\n');

    await this.lifecycle.initializeWithRetry();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.log('ListTools request', { count: WHATSAPP_TOOLS.length });
      return { tools: WHATSAPP_TOOLS };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      const startedAt = Date.now();
      const toolArgs = args as Record<string, unknown>;
      const state = this.lifecycle.getState();

      this.logger.log('Tool call received', {
        name,
        ready: state.ready,
        args: redactToolArgs(toolArgs),
      });

      try {
        const result = await this.toolRunner.run(name, toolArgs);
        this.logToolCompletion(name, startedAt, result);
        return result;
      } catch (error) {
        this.logger.log('Tool call threw', {
          name,
          durationMs: Date.now() - startedAt,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
        return fail((error as Error).message);
      }
    });
  }

  private logToolCompletion(name: string, startedAt: number, result: ToolResult): void {
    this.logger.log('Tool call completed', {
      name,
      isError: Boolean(result.isError),
      durationMs: Date.now() - startedAt,
    });
  }

  private registerProcessDiagnostics(): void {
    process.on('uncaughtException', (error) => {
      this.logger.log('Uncaught exception', { error: error.message, stack: error.stack });
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.log('Unhandled rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });
    process.on('exit', (code) => {
      this.logger.log('Process exiting', { code });
    });
    process.stdin.on('end', () => this.logger.log('stdin ended by MCP client'));
    process.stdin.on('close', () => this.logger.log('stdin closed by MCP client'));
    process.stdin.on('error', (error) => this.logger.log('stdin error', { error: error.message }));
    process.stdout.on('error', (error) => this.logger.log('stdout error', { error: error.message }));
  }
}

function createServer(): WhatsAppMcpServer {
  const logger = new FileMcpLogger();
  const clientFactory = new LocalAuthWhatsAppClientFactory(logger);
  const lifecycle = new WhatsAppLifecycleService(clientFactory, logger);
  const toolRunner = new WhatsAppToolRunner(lifecycle);

  return new WhatsAppMcpServer(logger, lifecycle, toolRunner);
}

export async function startMcpServer(): Promise<void> {
  await createServer().start();
}

if (require.main === module) {
  const logger = new FileMcpLogger();
  void startMcpServer().catch((error) => {
    logger.log('Fatal error', {
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
    process.exit(1);
  });
}
