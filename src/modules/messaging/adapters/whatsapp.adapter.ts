import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Client, LocalAuth, Message, MessageTypes } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import type { MessageAdapter, IncomingMessage, OutgoingMessage, MediaType } from '../../core/interfaces/message-adapter.interface';
import { BotService } from '../../bot/bot.service';
import { BotControlService } from '../../bot/bot-control.service';
import { ConfigLoaderService } from '../../config/config-loader.service';
import { BotConfigService } from '../../config/bot-config.service';
import { SessionService } from '../../session/session.service';
import { TrelloService } from '../../trello/trello.service';
import { OptOutService } from '../../opt-out/opt-out.service';
import { MessageStoreService } from '../message-store.service';

@Injectable()
export class WhatsAppAdapter implements MessageAdapter, OnApplicationBootstrap {
  readonly channelName = 'WhatsApp';
  private readonly logger = new Logger(WhatsAppAdapter.name);
  private client: Client;
  private readyAt: number | null = null;
  private connected = false;
  private readonly enabled = process.env['WHATSAPP_ENABLED'] !== 'false';
  private readonly initTimeoutMs = Number.parseInt(process.env['WHATSAPP_INIT_TIMEOUT_MS'] ?? '45000', 10);

  /** Recipients the bot is currently sending to — message_create events for these are ignored */
  private readonly botSendingTo = new Set<string>();
  private readonly botSentMessageIds = new Set<string>();
  private readonly botSentMessageSignatures = new Set<string>();
  private readonly botOriginTtlMs = 10 * 60 * 1000;
  private readonly botSendingWindowMs = 30 * 1000;

  /** Per-sender processing lock to avoid race conditions when multiple events arrive simultaneously */
  private readonly processingLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly botService: BotService,
    private readonly botControlService: BotControlService,
    private readonly configLoader: ConfigLoaderService,
    private readonly botConfig: BotConfigService,
    private readonly sessionService: SessionService,
    private readonly trelloService: TrelloService,
    private readonly optOutService: OptOutService,
    private readonly messageStore: MessageStoreService,
  ) {
    const sessionId = process.env['WHATSAPP_SESSION_ID'];
    // Use CHROME_PATH env var to override; otherwise let puppeteer use its own
    // bundled Chromium (avoids incompatibility when system Chrome is too new).
    const executablePath = process.env['CHROME_PATH'] || undefined;
    const webVersion = process.env['WHATSAPP_WEB_VERSION'] || undefined;
    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth',
        clientId: sessionId,
      }),
      ...(webVersion
        ? {
            webVersion,
            webVersionCache: {
              type: 'remote' as const,
              remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
            },
          }
        : {}),
      puppeteer: {
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('WHATSAPP_ENABLED=false — skipping WhatsApp adapter initialization');
      return;
    }
    await this.initialize();
  }

  async initialize(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('WHATSAPP_ENABLED=false — WhatsApp adapter disabled');
      return;
    }
    this.logger.log('Initializing WhatsApp adapter...');

    this.client.on('qr', (qr) => {
      this.logger.log('QR code received — scan it with your phone:');
      qrcode.generate(qr, { small: true });
    });

    this.client.on('ready', async () => {
      this.readyAt = Date.now();
      this.connected = true;
      this.logger.log('WhatsApp client is ready!');
      this.printPanelReady();
      void this.logAvailableGroups();
    });

    this.client.on('authenticated', () => {
      this.logger.log('WhatsApp authentication successful');
    });

    this.client.on('loading_screen', (percent, message) => {
      this.logger.log(`WhatsApp loading: ${percent}% ${message ?? ''}`.trim());
    });

    this.client.on('change_state', (state) => {
      this.logger.log(`WhatsApp state changed: ${state}`);
    });

    this.client.on('auth_failure', (msg) => {
      this.logger.error(`Authentication failed: ${msg}`);
    });

    this.client.on('disconnected', (reason) => {
      this.connected = false;
      this.logger.error(
        `Sesion de WhatsApp cerrada desde el celular o navegador. Motivo: ${reason}. Reinicia el bot y escanea el QR nuevamente.`,
      );
    });

    // Incoming messages from clients
    this.client.on('message', async (message: Message) => {
      await this.handleIncomingMessage(message);
    });

    // Outgoing messages sent manually by the developer — auto-pause the bot
    this.client.on('message_create', async (message: Message) => {
      if (!message.fromMe) return;
      const botSendingSnapshot = [...this.botSendingTo];
      this.logger.debug(`message_create → to=${message.to} | botSendingTo=[${botSendingSnapshot.join(',')}]`);
      if (this.isBotOriginatedOutgoing(message)) {
        this.logger.debug(`message_create ignored (bot-originated) for ${message.to}`);
        return;
      }
      await this.handleOutgoingMessage(message);
    });

    setImmediate(() => {
      void this.startClientInitialization();
    });
  }

  private async startClientInitialization(): Promise<void> {
    const initPromise = this.client.initialize();
    initPromise.catch((error) => {
      this.logger.error(`WhatsApp initialization failed: ${(error as Error).message}`);
    });

    await this.waitForInitializeOrTimeout(initPromise);
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.markBotSending(message.recipientId, message.text);
    try {
      await this.simulateTyping(message.recipientId, message.text);
      const sent = await this.client.sendMessage(message.recipientId, message.text);
      this.markBotSentMessage(message.recipientId, message.text, sent);
      this.logger.debug(`Sent to ${message.recipientId}`);
      this.messageStore.push({
        direction: 'out',
        senderId: message.recipientId,
        text: message.text,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.error(`Failed to send to ${message.recipientId}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Sends a broadcast message without triggering the auto-pause logic.
   * Use this for outbound-only messages (campaign, notifications) that
   * should NOT be interpreted as the developer taking over the conversation.
   */
  async sendBroadcast(recipientId: string, text: string): Promise<void> {
    this.logger.debug(`sendBroadcast → adding ${recipientId} to botSendingTo`);
    // Add invisible variation per recipient so each message has a unique content hash.
    // Zero-width Unicode chars are invisible to the human but break spam fingerprinting.
    const variedText = this.addInvisibleVariation(text, recipientId);
    this.markBotSending(recipientId, variedText);
    try {
      await this.simulateBroadcastTyping(recipientId, variedText);
      const sent = await this.client.sendMessage(recipientId, variedText);
      this.markBotSentMessage(recipientId, variedText, sent);
      this.logger.debug(`Broadcast sent to ${recipientId}`);
    } catch (error) {
      this.logger.error(`Broadcast failed to ${recipientId}: ${(error as Error).message}`);
      throw error;
    } finally {
      // Small delay before removing from set so the message_create event
      // (which arrives asynchronously after sendMessage resolves) is still blocked
      setTimeout(() => {
        this.botSendingTo.delete(recipientId);
        this.logger.debug(`sendBroadcast → removed ${recipientId} from botSendingTo`);
      }, 3000);
    }
  }

  /** Shows "typing..." indicator before sending a broadcast/campaign message. */
  private async simulateBroadcastTyping(recipientId: string, text: string): Promise<void> {
    // 20ms per char, clamped between 1.5s and 6s — realistic for a short WA message
    const typingMs = Math.min(Math.max(text.length * 20, 1500), 6000);
    try {
      const chat = await this.client.getChatById(recipientId);
      await chat.sendStateTyping();
      await new Promise((resolve) => setTimeout(resolve, typingMs));
      await chat.clearState();
    } catch {
      // Chat may not exist yet (new contact) — just wait the equivalent time
      await new Promise((resolve) => setTimeout(resolve, typingMs));
    }
  }

  /** Appends a zero-width Unicode char unique to each recipient.
   *  Makes the content hash different per message without any visible change. */
  private addInvisibleVariation(text: string, recipientId: string): string {
    const markers = ['​', '‌', '‍'];
    const digits = recipientId.replace(/\D/g, '');
    const sum = digits.split('').reduce((s, c) => s + Number(c), 0);
    return text + markers[sum % markers.length];
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Sends an alert to the configured control group. Safe to call even if WA is disconnected. */
  async sendControlAlert(message: string): Promise<void> {
    const groupId = this.botConfig.controlGroupId;
    if (!groupId || !this.connected) return;
    try {
      await this.client.sendMessage(groupId, message);
    } catch (err) {
      this.logger.warn(`sendControlAlert failed: ${(err as Error).message}`);
    }
  }

  // ─── Outgoing message handler (dev manual takeover) ──────────

  private markBotSending(recipientId: string, text: string): void {
    this.botSendingTo.add(recipientId);
    this.rememberBotSignature(recipientId, text);
    setTimeout(() => {
      this.botSendingTo.delete(recipientId);
      this.logger.debug(`botSendingTo window expired for ${recipientId}`);
    }, this.botSendingWindowMs);
  }

  private markBotSentMessage(recipientId: string, text: string, sent?: Message): void {
    this.rememberBotSignature(recipientId, text);
    const id = sent?.id?._serialized;
    if (!id) return;

    this.botSentMessageIds.add(id);
    setTimeout(() => {
      this.botSentMessageIds.delete(id);
    }, this.botOriginTtlMs);
  }

  private rememberBotSignature(recipientId: string, text: string): void {
    const signature = this.outgoingSignature(recipientId, text);
    this.botSentMessageSignatures.add(signature);
    setTimeout(() => {
      this.botSentMessageSignatures.delete(signature);
    }, this.botOriginTtlMs);
  }

  private isBotOriginatedOutgoing(message: Message): boolean {
    if (this.botSendingTo.has(message.to)) return true;

    const id = message.id?._serialized;
    if (id && this.botSentMessageIds.has(id)) return true;

    return this.botSentMessageSignatures.has(this.outgoingSignature(message.to, message.body ?? ''));
  }

  private outgoingSignature(recipientId: string, text: string): string {
    return `${recipientId}::${text.trim()}`;
  }

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
      this.botControlService.pause(to);

      // Notify control group and try to link @lid to @c.us
      if (to.endsWith('@lid')) {
        try {
          const contact = await message.getContact();
          if (contact && contact.number) {
            this.botControlService.pause(`${contact.number}@c.us`);
          }
        } catch (e) {
          // ignore
        }
      }

      // Notify control group
      if (controlGroupId) {
        const number = to.replace('@c.us', '').replace('@lid', '');
        void this.client.sendMessage(
          controlGroupId,
          `⏸️ Bot pausado para *${number}* — tomaste el control de la conversación.\n\nUsá \`!reactivar ${number}\` cuando termines.`,
        );
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
        '🤖 *BOT-Oscar — Comandos disponibles*',
        '',
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
      const pausedSenders = this.botControlService.getPausedSenders();
      const pausedList =
        pausedSenders.length > 0
          ? pausedSenders.map((s) => `  • ${s.replace('@c.us', '')}`).join('\n')
          : '  Ninguno';

      const statusMsg = [
        '📊 *Estado del bot*',
        '',
        `⏱️ *Uptime:* ${uptime}`,
        `🤖 *Proveedor IA:* ${provider}`,
        `👥 *Sesiones activas:* ${sessions.length}`,
        `⏸️ *Senders pausados:* ${pausedSenders.length}`,
        pausedSenders.length > 0 ? `\n${pausedList}` : '',
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
      this.botControlService.pause(senderId);
      await this.client.sendMessage(groupId, `⏸️ Bot pausado para *${pauseMatch[1]}*.`);
      return;
    }

    // ── !reactivar <número> ──────────────────────────────────────
    const reactivateMatch = text.match(/^!reactivar\s+(\d+)$/);
    if (reactivateMatch) {
      const senderId = `${reactivateMatch[1]}@c.us`;
      this.botControlService.resume(senderId);
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
    if (message.fromMe || message.from.endsWith('@g.us') || message.from === 'status@broadcast') return;

    // Skip empty text messages — WhatsApp sometimes fires phantom text events alongside audio/image
    if (message.type === MessageTypes.TEXT && !message.body?.trim()) {
      this.logger.debug(`Skipping empty text event from ${message.from}`);
      return;
    }

    if (this.optOutService.matches(message.body)) {
      const phone = message.from.replace('@c.us', '').replace('@lid', '');
      this.optOutService.add(phone, message.body, 'whatsapp');
      await this.client.sendMessage(
        message.from,
        'Listo, no vamos a enviarte más mensajes de campaña. Si necesitás soporte, escribí *menú*.',
      );
      return;
    }

    // Ignore messages sent before the client was ready (received while offline)
    const messageTimestampMs = message.timestamp * 1000;
    if (this.readyAt !== null && messageTimestampMs < this.readyAt) {
      this.logger.debug(`Skipping offline message from ${message.from} (sent before server started)`);
      return;
    }

    // Bot is paused for this sender — dev has taken over
    if (this.botControlService.isPaused(message.from) && this.isUserResumeCommand(message.body)) {
      this.botControlService.resume(message.from);
    } else if (this.botControlService.isPaused(message.from)) {
      this.logger.debug(`Bot paused for ${message.from} — skipping`);
      return;
    }

    // Unify @lid and @c.us for pausing purposes
    if (message.from.endsWith('@lid')) {
      try {
        const contact = await message.getContact();
        if (contact && contact.number) {
          const phoneJid = `${contact.number}@c.us`;
          if (this.botControlService.isPaused(phoneJid)) {
            this.logger.debug(`Bot paused for resolved phone ${phoneJid} (from ${message.from}) — skipping`);
            // Auto-pause the @lid so future checks are faster
            this.botControlService.pause(message.from);
            return;
          }
        }
      } catch (error) {
        // ignore
      }
    }

    // Serialize processing per sender to avoid race conditions when multiple
    // events arrive simultaneously (e.g. WhatsApp fires text + audio events at once)
    const senderId = message.from;
    const previous = this.processingLocks.get(senderId) ?? Promise.resolve();
    const current = previous.then(() => this.processMessage(message)).catch(() => {});
    this.processingLocks.set(senderId, current);
    await current;
    // Clean up the lock entry once done to avoid memory leak on long-running process
    if (this.processingLocks.get(senderId) === current) {
      this.processingLocks.delete(senderId);
    }
  }

  private async processMessage(message: Message): Promise<void> {
    const incoming = await this.buildIncomingMessage(message);

    this.logger.debug(
      `Incoming [${incoming.mediaType ?? 'text'}] from ${incoming.senderId}: "${(incoming.text || '').slice(0, 60)}"`,
    );

    const contact = await message.getContact().catch(() => null);
    this.messageStore.push({
      direction: 'in',
      senderId: incoming.senderId,
      senderName: contact?.pushname || contact?.name || undefined,
      text: incoming.text,
      mediaType: incoming.mediaType,
      timestamp: Date.now(),
    });

    try {
      await this.botService.handleMessage(incoming, this);
    } catch (error) {
      this.logger.error(`Error handling message: ${(error as Error).message}`);
    }
  }

  // ─── Log groups on ready ──────────────────────────────────────

  private isUserResumeCommand(text: string | undefined): boolean {
    const normalized = (text ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    return ['menu', 'volver', 'inicio', 'reactivar'].includes(normalized);
  }

  private async logAvailableGroups(): Promise<void> {
    try {
      const chats = await this.withTimeout(this.client.getChats(), 15000, 'Timed out loading WhatsApp groups');
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

  private printPanelReady(): void {
    const port = process.env['PORT'] ?? 3000;
    process.stdout.write(
      `\nWhatsApp conectado. Ya podes abrir el panel: http://127.0.0.1:${port}/panel\n\n`,
    );
  }

  private async waitForInitializeOrTimeout(initPromise: Promise<void>): Promise<void> {
    try {
      await this.withTimeout(
        initPromise,
        Number.isFinite(this.initTimeoutMs) ? this.initTimeoutMs : 45000,
        'WhatsApp initialization is still running in the background',
      );
    } catch (error) {
      this.logger.warn((error as Error).message);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
