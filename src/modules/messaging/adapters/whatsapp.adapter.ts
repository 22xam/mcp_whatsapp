import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Client, LocalAuth, Message, MessageTypes } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import type { MessageAdapter, IncomingMessage, OutgoingMessage, MediaType } from '../../core/interfaces/message-adapter.interface';
import { BotService } from '../../bot/bot.service';
import { ConfigLoaderService } from '../../config/config-loader.service';
import { BotConfigService } from '../../config/bot-config.service';

@Injectable()
export class WhatsAppAdapter implements MessageAdapter, OnApplicationBootstrap {
  readonly channelName = 'WhatsApp';
  private readonly logger = new Logger(WhatsAppAdapter.name);
  private client: Client;
  private readyAt: number | null = null;

  /** Senders for whom the bot is paused (dev took over the conversation) */
  private readonly pausedSenders = new Set<string>();

  constructor(
    private readonly botService: BotService,
    private readonly configLoader: ConfigLoaderService,
    private readonly botConfig: BotConfigService,
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
      await this.handleOutgoingMessage(message);
    });

    await this.client.initialize();
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    try {
      await this.simulateTyping(message.recipientId, message.text);
      await this.client.sendMessage(message.recipientId, message.text);
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
    if (to.endsWith('@c.us')) {
      this.pauseSender(to);
    }
  }

  // ─── Control group commands ───────────────────────────────────

  private async handleControlCommand(message: Message): Promise<void> {
    const text = message.body?.trim() ?? '';
    const groupId = this.botConfig.controlGroupId!;

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

    if (text === '!estado') {
      if (this.pausedSenders.size === 0) {
        await this.client.sendMessage(groupId, '✅ El bot está activo para todos los clientes.');
        return;
      }
      const lines = [...this.pausedSenders].map((s) => `• ${s.replace('@c.us', '')}`);
      await this.client.sendMessage(
        groupId,
        `⏸️ *Bot pausado para:*\n\n${lines.join('\n')}\n\nUsá \`!reactivar <número>\` para reactivarlo.`,
      );
      return;
    }

    const pauseMatch = text.match(/^!pausar\s+(\d+)$/);
    if (pauseMatch) {
      const senderId = `${pauseMatch[1]}@c.us`;
      this.pauseSender(senderId);
      await this.client.sendMessage(groupId, `⏸️ Bot pausado para *${pauseMatch[1]}*.`);
      return;
    }

    const reactivateMatch = text.match(/^!reactivar\s+(\d+)$/);
    if (reactivateMatch) {
      const senderId = `${reactivateMatch[1]}@c.us`;
      this.resumeSender(senderId);
      await this.client.sendMessage(groupId, `▶️ Bot reactivado para *${reactivateMatch[1]}*.`);
      return;
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
}
