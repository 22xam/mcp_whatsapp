import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Client, LocalAuth, Message, MessageTypes } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import type { MessageAdapter, IncomingMessage, OutgoingMessage, MediaType } from '../../core/interfaces/message-adapter.interface';
import { BotService } from '../../bot/bot.service';
import { ConfigLoaderService } from '../../config/config-loader.service';
import { BotConfigService } from '../../config/bot-config.service';
import { SessionService } from '../../session/session.service';
import { TrelloService } from '../../trello/trello.service';

@Injectable()
export class WhatsAppAdapter implements MessageAdapter, OnApplicationBootstrap {
  readonly channelName = 'WhatsApp';
  private readonly logger = new Logger(WhatsAppAdapter.name);
  private client: Client;
  private readyAt: number | null = null;

  /** Senders for whom the bot is paused (dev took over the conversation) */
  private readonly pausedSenders = new Set<string>();

  /** IDs of messages sent programmatically by the bot (to ignore in message_create) */
  private readonly botSentMessageIds = new Set<string>();

  constructor(
    private readonly botService: BotService,
    private readonly configLoader: ConfigLoaderService,
    private readonly botConfig: BotConfigService,
    private readonly sessionService: SessionService,
    private readonly trelloService: TrelloService,
  ) {
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    this.logger.log('Initializing WhatsApp adapter...');

    this.client.on('qr', (qr) => {
      this.logger.log('QR code received — scan it with your phone:');
      qrcode.generate(qr, { small: true });
    });

    this.client.on('ready', async () => {
      this.readyAt = Date.now();
      this.logger.log('WhatsApp client is ready!');
      await this.logAvailableGroups();
    });

    this.client.on('authenticated', () => {
      this.logger.log('WhatsApp authentication successful');
    });

    this.client.on('auth_failure', (msg) => {
      this.logger.error(`Authentication failed: ${msg}`);
    });

    this.client.on('disconnected', (reason) => {
      this.logger.warn(`Disconnected: ${reason}`);
    });

    // Incoming messages from clients
    this.client.on('message', async (message: Message) => {
      await this.handleIncomingMessage(message);
    });

    // Outgoing messages sent manually by the developer — auto-pause the bot
    this.client.on('message_create', async (message: Message) => {
      if (!message.fromMe) return;
      // Ignore messages sent programmatically by the bot itself
      if (this.botSentMessageIds.delete(message.id.id)) return;
      await this.handleOutgoingMessage(message);
    });

    await this.client.initialize();
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    try {
      await this.simulateTyping(message.recipientId, message.text);
      const sent = await this.client.sendMessage(message.recipientId, message.text);
      this.botSentMessageIds.add(sent.id.id);
      this.logger.debug(`Sent to ${message.recipientId}`);
    } catch (error) {
      this.logger.error(`Failed to send to ${message.recipientId}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ─── Outgoing message handler (dev manual takeover) ──────────

  private async handleOutgoingMessage(message: Message): Promise<void> {
    const to = message.to;

    // Control group commands
    const controlGroupId = this.botConfig.controlGroupId;
    if (controlGroupId && to === controlGroupId) {
      await this.handleControlCommand(message);
      return;
    }

    // Dev sent a message manually to a client → pause the bot for that sender
    if (to.endsWith('@c.us') || to.endsWith('@lid')) {
      this.pauseSender(to);

      // Try to link @lid to @c.us just in case
      if (to.endsWith('@lid')) {
        try {
          const contact = await message.getContact();
          if (contact && contact.number) {
            this.pauseSender(`${contact.number}@c.us`);
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }

  // ─── Control group commands ───────────────────────────────────

  private async handleControlCommand(message: Message): Promise<void> {
    const text = message.body?.trim() ?? '';
    const groupId = this.botConfig.controlGroupId!;

    // ── !ayuda ──────────────────────────────────────────────────
    if (text === '!ayuda') {
      const trelloStatus = this.trelloService.isEnabled ? '✅ conectado' : '❌ no configurado';
      const help = [
        '🤖 *BugMate — Comandos disponibles*\n',
        '*📊 Información*',
        '`!estado` — Estado del bot: uptime, IA, sesiones activas, senders pausados',
        '`!sesiones` — Lista sesiones activas con flujo y paso actual',
        '`!flujos` — Lista todos los flujos configurados con sus pasos',
        '',
        '*⏸️ Control de conversaciones*',
        '`!pausar <número>` — Pausar el bot para un número (toma control manual)',
        '`!reactivar <número>` — Reactivar el bot para un número',
        '',
        '*🔧 Configuración*',
        '`!grupos` — Lista todos los grupos con sus IDs',
        `\`!trello\` — Lista tableros y columnas de Trello (${trelloStatus})`,
        '',
        '`!ayuda` — Muestra este mensaje',
      ].join('\n');
      await this.client.sendMessage(groupId, help);
      return;
    }

    // ── !grupos ─────────────────────────────────────────────────
    if (text === '!grupos') {
      const chats = await this.client.getChats();
      const groups = chats.filter((c) => c.isGroup);
      if (groups.length === 0) {
        await this.client.sendMessage(groupId, '⚠️ El bot no está en ningún grupo.');
        return;
      }
      const lines = groups.map((g) => `• *${g.name}*\n  ID: \`${g.id._serialized}\``);
      await this.client.sendMessage(groupId, `📋 *Grupos disponibles:*\n\n${lines.join('\n\n')}`);
      return;
    }

    // ── !estado ─────────────────────────────────────────────────
    if (text === '!estado') {
      const uptime = this.formatUptime(this.sessionService.uptime);
      const provider = this.botConfig.aiProvider;
      const sessions = this.sessionService.getAllSessions();
      const pausedList =
        this.pausedSenders.size > 0
          ? [...this.pausedSenders].map((s) => `  • ${s.replace('@c.us', '')}`).join('\n')
          : '  Ninguno';

      const statusMsg = [
        '📊 *Estado del bot*\n',
        `⏱️ *Uptime:* ${uptime}`,
        `🤖 *Proveedor IA:* ${provider}`,
        `👥 *Sesiones activas:* ${sessions.length}`,
        `⏸️ *Senders pausados:* ${this.pausedSenders.size}`,
        pausedList !== '  Ninguno' ? `\n${pausedList}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      await this.client.sendMessage(groupId, statusMsg);
      return;
    }

    // ── !sesiones ────────────────────────────────────────────────
    if (text === '!sesiones') {
      const sessions = this.sessionService.getAllSessions();
      if (sessions.length === 0) {
        await this.client.sendMessage(groupId, '📭 No hay sesiones activas.');
        return;
      }

      const lines = sessions.map((s) => {
        const phone = s.senderId.replace('@c.us', '');
        const name = s.clientName !== '👋' ? ` (${s.clientName})` : '';
        const step = s.activeStepId ? ` → paso: \`${s.activeStepId}\`` : '';
        const flow = s.activeConditionalFlowId
          ? ` [flujo: ${s.activeConditionalFlowId}]`
          : s.activeFlowId
            ? ` [flujo: ${s.activeFlowId}]`
            : '';
        const ago = this.timeAgo(s.lastActivityAt);
        return `• *${phone}*${name}\n  Estado: \`${s.state}\`${flow}${step}\n  Última actividad: ${ago}`;
      });

      await this.client.sendMessage(
        groupId,
        `👥 *Sesiones activas (${sessions.length}):*\n\n${lines.join('\n\n')}`,
      );
      return;
    }

    // ── !flujos ─────────────────────────────────────────────────
    if (text === '!flujos') {
      const { flows, conditionalFlows } = this.configLoader.botConfig;
      const lines: string[] = [];

      if (conditionalFlows && Object.keys(conditionalFlows).length > 0) {
        lines.push('*Flujos condicionales (nuevos):*');
        for (const [id, flow] of Object.entries(conditionalFlows)) {
          const stepCount = Object.keys(flow.steps).length;
          const stepNames = Object.keys(flow.steps).join(', ');
          lines.push(`• \`${id}\` — ${stepCount} pasos: ${stepNames}`);
        }
      }

      if (Object.keys(flows).length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('*Flujos legacy (guided/ai):*');
        for (const [id, flow] of Object.entries(flows)) {
          const detail = flow.type === 'guided' ? `${flow.steps.length} pasos` : 'IA';
          lines.push(`• \`${id}\` [${flow.type}] — ${detail}`);
        }
      }

      if (lines.length === 0) {
        await this.client.sendMessage(groupId, '⚠️ No hay flujos configurados.');
        return;
      }

      await this.client.sendMessage(groupId, `🔀 *Flujos configurados:*\n\n${lines.join('\n')}`);
      return;
    }

    // ── !pausar <número> ─────────────────────────────────────────
    const pauseMatch = text.match(/^!pausar\s+(\d+)$/);
    if (pauseMatch) {
      const senderId = `${pauseMatch[1]}@c.us`;
      this.pauseSender(senderId);
      await this.client.sendMessage(groupId, `⏸️ Bot pausado para *${pauseMatch[1]}*.`);
      return;
    }

    // ── !reactivar <número> ──────────────────────────────────────
    const reactivateMatch = text.match(/^!reactivar\s+(\d+)$/);
    if (reactivateMatch) {
      const senderId = `${reactivateMatch[1]}@c.us`;
      this.resumeSender(senderId);
      await this.client.sendMessage(groupId, `▶️ Bot reactivado para *${reactivateMatch[1]}*.`);
      return;
    }

    // ── !trello ──────────────────────────────────────────────────
    if (text === '!trello') {
      if (!this.trelloService.isEnabled) {
        await this.client.sendMessage(
          groupId,
          '❌ *Trello no configurado*\n\nAgregá `TRELLO_API_KEY` y `TRELLO_TOKEN` en tu `.env`.\n\nObtené tus credenciales en: https://trello.com/power-ups/admin',
        );
        return;
      }

      await this.client.sendMessage(groupId, '🔄 Consultando tableros de Trello...');

      const boards = await this.trelloService.getBoards();
      if (boards.length === 0) {
        await this.client.sendMessage(groupId, '⚠️ No se encontraron tableros de Trello para este token.');
        return;
      }

      const lines: string[] = ['📋 *Tableros y columnas de Trello*\n'];
      lines.push('Copiá los IDs que necesitás al campo `trello.lists` de tu `bot.config.json`.\n');

      for (const board of boards) {
        lines.push(`*📌 ${board.name}*`);
        const lists = await this.trelloService.getListsForBoard(board.id);
        if (lists.length === 0) {
          lines.push('  _(sin columnas)_');
        } else {
          for (const list of lists) {
            lines.push(`  • *${list.name}*\n    ID: \`${list.id}\``);
          }
        }
        lines.push('');
      }

      lines.push('*Ejemplo de configuración en bot.config.json:*');
      lines.push('```');
      lines.push('"trello": {');
      lines.push('  "enabled": true,');
      lines.push('  "lists": {');
      lines.push('    "bugs": "<ID de la columna Bugs>",');
      lines.push('    "pendientes": "<ID de la columna Pendientes>"');
      lines.push('  }');
      lines.push('}');
      lines.push('```');

      await this.client.sendMessage(groupId, lines.join('\n'));
      return;
    }

    // ── Comando no reconocido ─────────────────────────────────────
    if (text.startsWith('!')) {
      await this.client.sendMessage(
        groupId,
        `❓ Comando no reconocido: \`${text}\`\n\nEscribí \`!ayuda\` para ver los comandos disponibles.`,
      );
    }
  }

  // ─── Incoming message handler ─────────────────────────────────

  private async handleIncomingMessage(message: Message): Promise<void> {
    if (message.fromMe || message.from.endsWith('@g.us')) return;

    // Ignore messages sent before the client was ready (received while offline)
    const messageTimestampMs = message.timestamp * 1000;
    if (this.readyAt !== null && messageTimestampMs < this.readyAt) {
      this.logger.debug(`Skipping offline message from ${message.from} (sent before server started)`);
      return;
    }

    // Bot is paused for this sender — dev has taken over
    if (this.pausedSenders.has(message.from)) {
      this.logger.debug(`Bot paused for ${message.from} — skipping`);
      return;
    }

    // Unify @lid and @c.us for pausing purposes
    if (message.from.endsWith('@lid')) {
      try {
        const contact = await message.getContact();
        if (contact && contact.number) {
          const phoneJid = `${contact.number}@c.us`;
          if (this.pausedSenders.has(phoneJid)) {
            this.logger.debug(`Bot paused for resolved phone ${phoneJid} (from ${message.from}) — skipping`);
            // Auto-pause the @lid so future checks are faster
            this.pauseSender(message.from);
            return;
          }
        }
      } catch (error) {
        // ignore
      }
    }

    const incoming = await this.buildIncomingMessage(message);

    this.logger.debug(
      `Incoming [${incoming.mediaType ?? 'text'}] from ${incoming.senderId}: "${(incoming.text || '').slice(0, 60)}"`,
    );

    try {
      await this.botService.handleMessage(incoming, this);
    } catch (error) {
      this.logger.error(`Error handling message: ${(error as Error).message}`);
    }
  }

  // ─── Pause / resume helpers ───────────────────────────────────

  private pauseSender(senderId: string): void {
    if (!this.pausedSenders.has(senderId)) {
      this.pausedSenders.add(senderId);
      this.logger.log(`Bot paused for ${senderId} (dev takeover)`);

      const controlGroupId = this.botConfig.controlGroupId;
      if (controlGroupId) {
        const number = senderId.replace('@c.us', '');
        void this.client.sendMessage(
          controlGroupId,
          `⏸️ Bot pausado para *${number}* — tomaste el control de la conversación.\n\nUsá \`!reactivar ${number}\` cuando termines.`,
        );
      }
    }
  }

  private resumeSender(senderId: string): void {
    this.pausedSenders.delete(senderId);
    this.logger.log(`Bot resumed for ${senderId}`);
  }

  // ─── Log groups on ready ──────────────────────────────────────

  private async logAvailableGroups(): Promise<void> {
    try {
      const chats = await this.client.getChats();
      const groups = chats.filter((c) => c.isGroup);
      if (groups.length === 0) {
        this.logger.log('No groups found. Create a group and add the bot to use the control group feature.');
        return;
      }
      this.logger.log('── Available groups ──────────────────────────────');
      for (const g of groups) {
        this.logger.log(`  ${g.name}  →  ${g.id._serialized}`);
      }
      this.logger.log('─────────────────────────────────────────────────');
      this.logger.log('Set CONTROL_GROUP_ID=<id> in .env to enable control commands.');
    } catch {
      // Non-critical — ignore
    }
  }

  // ─── Message builders ─────────────────────────────────────────

  private async buildIncomingMessage(message: Message): Promise<IncomingMessage> {
    const base: IncomingMessage = {
      senderId: message.from,
      text: message.body ?? '',
      channel: this.channelName,
      raw: message,
    };

    const { media: mediaConfig } = this.configLoader.botConfig;

    if (message.type === MessageTypes.IMAGE && mediaConfig.processImages) {
      return this.enrichWithMedia(base, message, 'image');
    }

    if (
      (message.type === MessageTypes.AUDIO || message.type === MessageTypes.VOICE) &&
      mediaConfig.processAudio
    ) {
      return this.enrichWithMedia(base, message, 'audio');
    }

    if (
      message.type === MessageTypes.VIDEO ||
      message.type === MessageTypes.DOCUMENT ||
      message.type === MessageTypes.STICKER
    ) {
      const typeLabels: Partial<Record<string, string>> = {
        video: 'video',
        document: 'documento',
        sticker: 'sticker',
      };
      const label = typeLabels[message.type] ?? message.type;
      return {
        ...base,
        text: mediaConfig.unsupportedMessage.replace('{mediaType}', label),
        mediaType: message.type as MediaType,
      };
    }

    return base;
  }

  private async enrichWithMedia(
    base: IncomingMessage,
    message: Message,
    type: MediaType,
  ): Promise<IncomingMessage> {
    try {
      const media = await message.downloadMedia();
      if (!media) return base;
      return {
        ...base,
        mediaType: type,
        mediaBase64: media.data,
        mediaMimeType: media.mimetype,
      };
    } catch (error) {
      this.logger.warn(`Could not download media: ${(error as Error).message}`);
      return base;
    }
  }

  private async simulateTyping(recipientId: string, text: string): Promise<void> {
    const { humanDelay } = this.configLoader.botConfig;
    if (!humanDelay.enabled) return;

    const readingMs =
      humanDelay.readingDelayMinMs +
      Math.random() * (humanDelay.readingDelayMaxMs - humanDelay.readingDelayMinMs);

    const typingMs = Math.min(
      Math.max(text.length * humanDelay.msPerCharacter, humanDelay.minDelayMs),
      humanDelay.maxDelayMs,
    );

    await new Promise((resolve) => setTimeout(resolve, readingMs));

    try {
      const chat = await this.client.getChatById(recipientId);
      await chat.sendStateTyping();
      await new Promise((resolve) => setTimeout(resolve, typingMs));
      await chat.clearState();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, typingMs));
    }
  }

  // ─── Formatting helpers ───────────────────────────────────────

  private formatUptime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  private timeAgo(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `hace ${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `hace ${diffMin}m`;
    return `hace ${Math.floor(diffMin / 60)}h`;
  }
}
