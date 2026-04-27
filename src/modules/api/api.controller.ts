import { Body, Controller, Delete, Get, Inject, Optional, Param, Post, Query, Res, Sse } from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs/operators';
import { LogBufferService } from './log-buffer.service';
import { SessionService } from '../session/session.service';
import { ConfigLoaderService } from '../config/config-loader.service';
import { BotConfigService } from '../config/bot-config.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { BotControlService } from '../bot/bot-control.service';
import { BotService } from '../bot/bot.service';
import { TrelloService } from '../trello/trello.service';
import { BroadcastService } from './broadcast.service';
import { OpenRouterProvider } from '../ai/providers/openrouter.provider';
import { AuditService } from '../data/audit.service';
import { MessageStoreService } from '../messaging/message-store.service';
import type { MessageAdapter, OutgoingMessage, IncomingMessage } from '../core/interfaces/message-adapter.interface';

/** In-memory adapter that captures bot responses instead of sending to WhatsApp. */
class CaptureAdapter implements MessageAdapter {
  readonly channelName = 'CLI-Test';
  readonly responses: string[] = [];

  async initialize(): Promise<void> {}

  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.responses.push(message.text);
  }
}

@Controller('api')
export class ApiController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly configLoader: ConfigLoaderService,
    private readonly botConfig: BotConfigService,
    private readonly knowledgeService: KnowledgeService,
    private readonly botControlService: BotControlService,
    private readonly botService: BotService,
    private readonly trelloService: TrelloService,
    private readonly broadcastService: BroadcastService,
    private readonly openRouterProvider: OpenRouterProvider,
    private readonly auditService: AuditService,
    private readonly messageStore: MessageStoreService,
    @Optional() @Inject(LogBufferService) private readonly logBuffer: LogBufferService,
  ) {}

  // ─── Status ──────────────────────────────────────────────────

  @Get('status')
  getStatus() {
    const sessions = this.sessionService.getAllSessions();
    const config = this.configLoader.botConfig;
    const uptime = this.sessionService.uptime;
    const pausedSenders = this.botControlService.getPausedSenders();

    return {
      uptime,
      uptimeFormatted: this.formatUptime(uptime),
      aiProvider: this.botConfig.aiProvider,
      mode: config.mode ?? 'flow',
      activeSessions: sessions.length,
      pausedCount: pausedSenders.length,
      pausedSenders: pausedSenders.map((s) => s.replace('@c.us', '').replace('@lid', '')),
      botName: config.identity.name,
      company: config.identity.company,
      developerName: config.identity.developerName,
      trelloEnabled: this.trelloService.isEnabled,
    };
  }

  // ─── Sessions ────────────────────────────────────────────────

  @Get('sessions')
  getSessions() {
    return this.sessionService.getAllSessions();
  }

  @Delete('sessions/:id')
  clearSession(@Param('id') id: string) {
    const senderId = id.includes('@') ? id : `${id}@c.us`;
    this.sessionService.reset(senderId);
    return { ok: true, message: `Sesión limpiada para ${id}` };
  }

  // ─── Flows ───────────────────────────────────────────────────

  @Get('flows')
  getFlows() {
    const { flows, conditionalFlows } = this.configLoader.botConfig;
    return {
      conditionalFlows: Object.entries(conditionalFlows ?? {}).map(([id, flow]) => ({
        id,
        stepCount: Object.keys(flow.steps).length,
        steps: Object.keys(flow.steps),
      })),
      legacyFlows: Object.entries(flows ?? {}).map(([id, flow]) => ({
        id,
        type: flow.type,
        detail: flow.type === 'guided' ? `${flow.steps.length} pasos` : 'IA',
      })),
    };
  }

  // ─── Pause / Resume ──────────────────────────────────────────

  @Get('paused')
  getPaused() {
    return {
      senders: this.botControlService
        .getPausedSenders()
        .map((s) => s.replace('@c.us', '').replace('@lid', '')),
    };
  }

  @Post('pause')
  pause(@Body() body: { number: string }) {
    const senderId = body.number.includes('@') ? body.number : `${body.number}@c.us`;
    const isNew = this.botControlService.pause(senderId);
    this.auditService.record({
      entityType: 'conversation',
      entityId: senderId,
      action: 'paused',
      source: 'api',
      metadata: { isNew },
    });
    return { ok: true, isNew, number: body.number };
  }

  @Post('resume')
  resume(@Body() body: { number: string }) {
    const senderId = body.number.includes('@') ? body.number : `${body.number}@c.us`;
    const existed = this.botControlService.resume(senderId);
    this.auditService.record({
      entityType: 'conversation',
      entityId: senderId,
      action: 'resumed',
      source: 'api',
      metadata: { existed },
    });
    return { ok: true, existed, number: body.number };
  }

  @Post('resume/all')
  resumeAll() {
    const paused = this.botControlService.getPausedSenders();
    paused.forEach((s) => this.botControlService.resume(s));
    const resumed = paused.map((s) => s.replace('@c.us', '').replace('@lid', ''));
    this.auditService.record({
      entityType: 'conversation',
      action: 'resume_all',
      source: 'api',
      metadata: { count: resumed.length, resumed },
    });
    return { ok: true, count: resumed.length, resumed };
  }

  // ─── Test message simulation ─────────────────────────────────

  @Post('test/message')
  async testMessage(@Body() body: { senderId: string; text: string }) {
    const senderId = body.senderId.includes('@') ? body.senderId : `${body.senderId}@c.us`;
    const adapter = new CaptureAdapter();
    const incoming: IncomingMessage = {
      senderId,
      text: body.text,
      channel: 'CLI-Test',
    };

    await this.botService.handleMessage(incoming, adapter);

    const session = this.sessionService
      .getAllSessions()
      .find((s) => s.senderId === senderId);

    return {
      responses: adapter.responses,
      session: session
        ? {
            state: session.state,
            activeFlowId: session.activeFlowId,
            activeConditionalFlowId: session.activeConditionalFlowId,
            activeStepId: session.activeStepId,
          }
        : null,
    };
  }

  // ─── Knowledge ───────────────────────────────────────────────

  @Get('knowledge/search')
  async searchKnowledge(@Query('q') query: string, @Query('limit') limit?: string) {
    if (!query) return { result: null, query: '' };
    const results = await this.knowledgeService.searchMany(
      query,
      undefined,
      limit ? Number(limit) : this.configLoader.botConfig.ai.ragTopK,
    );
    return {
      result: results[0] ?? null,
      results,
      sources: results.map((result, index) => ({
        label: `S${index + 1}`,
        source: result.source,
        score: result.score,
        content: result.content,
      })),
      query,
    };
  }

  @Post('knowledge/rebuild')
  async rebuildKnowledge() {
    await this.knowledgeService.rebuild();
    return { ok: true, message: 'Índice de conocimiento reconstruido exitosamente' };
  }

  // ─── Config ──────────────────────────────────────────────────

  @Get('config')
  getConfig() {
    const config = this.configLoader.botConfig;
    return {
      identity: config.identity,
      mode: config.mode ?? 'flow',
      greeting: {
        sessionTimeoutMinutes: config.greeting.sessionTimeoutMinutes,
        unknownClientName: config.greeting.unknownClientName,
      },
      menu: {
        options: config.menu.options,
      },
      ai: {
        provider: this.botConfig.aiProvider,
        model: config.ai.model,
        embeddingModel: config.ai.embeddingModel,
        useKnowledge: config.ai.useKnowledge,
        ragTopK: config.ai.ragTopK,
        ragMinScore: config.ai.ragMinScore,
        maxHistoryMessages: config.ai.maxHistoryMessages,
        memoryEnabled: config.ai.memoryEnabled ?? true,
        memoryRecentMessages: config.ai.memoryRecentMessages ?? config.ai.maxHistoryMessages,
        memorySummaryThreshold: config.ai.memorySummaryThreshold ?? 24,
        fallbackToEscalation: config.ai.fallbackToEscalation,
      },
      escalation: {
        keywords: config.escalation.keywords,
      },
      humanDelay: config.humanDelay,
      trello: {
        enabled: this.trelloService.isEnabled,
        lists: (config.trello as any)?.lists ?? {},
      },
    };
  }

  @Get('audit')
  getAudit(
    @Query('limit') limit?: string,
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
  ) {
    return {
      events: this.auditService.list(limit ? Number(limit) : 100, { entityType, action }),
    };
  }

  // OpenRouter

  @Get('openrouter/models')
  async getOpenRouterModels(@Query('output') output = 'text') {
    const models = output === 'text'
      ? await this.openRouterProvider.listChatModels()
      : await this.openRouterProvider.listModels(output);
    return {
      provider: 'openrouter',
      output,
      count: models.length,
      models,
    };
  }

  @Get('openrouter/embedding-models')
  async getOpenRouterEmbeddingModels() {
    const models = await this.openRouterProvider.listEmbeddingModels();
    return {
      provider: 'openrouter',
      count: models.length,
      models,
    };
  }

  // ─── Trello ──────────────────────────────────────────────────

  @Get('trello/boards')
  async getTrelloBoards() {
    if (!this.trelloService.isEnabled) {
      return { enabled: false, boards: [] };
    }

    const boards = await this.trelloService.getBoards();
    const result: Array<{ id: string; name: string; lists: unknown[] }> = [];
    for (const board of boards) {
      const lists = await this.trelloService.getListsForBoard(board.id);
      result.push({ id: board.id, name: board.name, lists });
    }
    return { enabled: true, boards: result };
  }

  // ─── Broadcast ───────────────────────────────────────────────

  @Post('broadcast/good-morning')
  async broadcastCampaignIntro(@Body() body: { phones?: string[] }) {
    const clients = this.configLoader.clients;

    // Use provided list or fall back to all registered clients
    const phones: string[] =
      body?.phones && body.phones.length > 0
        ? body.phones
        : clients.map((c) => c.phone);

    if (phones.length === 0) {
      return { ok: false, message: 'No hay clientes registrados en clients.json.' };
    }

    const results = await this.broadcastService.sendCampaignIntro(phones);
    const sent = results.filter((r) => r.status === 'sent').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;

    return { ok: true, sent, failed, skipped, results };
  }

  // ─── Messages ────────────────────────────────────────────────

  @Get('messages')
  getMessages(@Query('senderId') senderId?: string, @Query('limit') limit?: string) {
    return this.messageStore.getAll(senderId, limit ? Number(limit) : 200);
  }

  @Get('messages/senders')
  getMessageSenders() {
    return this.messageStore.getSenders();
  }

  @Sse('messages/stream')
  streamMessages(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    return this.messageStore.events$.pipe(
      map((msg) => ({ data: JSON.stringify(msg) })),
    );
  }

  // ─── Logs ────────────────────────────────────────────────────

  @Get('logs')
  getLogs(@Query('limit') limit?: string) {
    return this.logBuffer?.getRecent(limit ? Number(limit) : 200) ?? [];
  }

  @Sse('logs/stream')
  streamLogs(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    return (this.logBuffer?.events$ ?? new (require('rxjs').Subject)()).pipe(
      map((entry) => ({ data: JSON.stringify(entry) })),
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private formatUptime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
}
