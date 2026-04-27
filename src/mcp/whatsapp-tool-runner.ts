import type { Chat, Client, Contact } from 'whatsapp-web.js';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface WhatsAppConnectionState {
  ready: boolean;
  readyAt: number | null;
}

export interface WhatsAppClientProvider {
  getClient(): Client;
  getState(): WhatsAppConnectionState;
}

type MessageSummary = {
  id: string;
  from: string;
  to: string;
  fromMe: boolean;
  body: string;
  type: string;
  timestamp: string | null;
  hasMedia: boolean;
};

export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(msg: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

function chatId(phone?: string, id?: string): string {
  if (id) return id;
  if (phone) return `${phone.replace(/\D/g, '')}@c.us`;
  throw new Error('Se requiere phone o chat_id');
}

function cappedLimit(value: unknown, fallback = 20, max = 100): number {
  return Math.min(Number(value ?? fallback), max);
}

export class WhatsAppToolRunner {
  constructor(private readonly provider: WhatsAppClientProvider) {}

  async run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const state = this.provider.getState();
    if (!state.ready && name !== 'wa_get_status') {
      return fail('WhatsApp no esta listo aun. Espera el QR o la autenticacion.');
    }

    switch (name) {
      case 'wa_get_status':
        return ok({
          ready: state.ready,
          readyAt: state.readyAt ? new Date(state.readyAt).toISOString() : null,
          uptime: state.readyAt ? `${Math.round((Date.now() - state.readyAt) / 1000)}s` : null,
        });

      case 'wa_get_profile_info':
        return this.getProfileInfo();

      case 'wa_send_message':
        return this.sendMessage(args);

      case 'wa_send_to_group':
        return this.sendToGroup(args);

      case 'wa_get_chats':
        return this.getChats(args);

      case 'wa_get_messages':
        return this.getMessages(args);

      case 'wa_get_contact':
        return this.getContact(args);

      case 'wa_get_groups':
        return this.getGroups();

      case 'wa_get_group_participants':
        return this.getGroupParticipants(args);

      case 'wa_search_messages':
        return this.searchMessages(args);

      case 'wa_mark_as_read':
        return this.markAsRead(args);

      case 'wa_get_unread_chats':
        return this.getUnreadChats(args);

      case 'wa_check_number_exists':
        return this.checkNumberExists(args);

      default:
        return fail(`Tool desconocida: ${name}`);
    }
  }

  private get wa(): Client {
    return this.provider.getClient();
  }

  private async getProfileInfo(): Promise<ToolResult> {
    const info = await this.wa.info;
    return ok({
      name: info?.pushname,
      phone: info?.wid?.user,
      platform: info?.platform,
    });
  }

  private async sendMessage(args: Record<string, unknown>): Promise<ToolResult> {
    const to = chatId(args.phone as string | undefined);
    await this.wa.sendMessage(to, args.text as string);
    return ok({ sent: true, to, text: args.text });
  }

  private async sendToGroup(args: Record<string, unknown>): Promise<ToolResult> {
    await this.wa.sendMessage(args.group_id as string, args.text as string);
    return ok({ sent: true, group_id: args.group_id, text: args.text });
  }

  private async getChats(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = cappedLimit(args.limit);
    const type = (args.type as string) ?? 'all';
    const chats = await this.wa.getChats();
    const filtered = chats
      .filter((chat) => {
        if (type === 'individual') return !chat.isGroup;
        if (type === 'group') return chat.isGroup;
        return true;
      })
      .slice(0, limit);

    return ok(
      filtered.map((chat) => ({
        id: chat.id._serialized,
        name: chat.name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        lastMessage: (chat as any).lastMessage?.body?.slice(0, 100) ?? null,
        timestamp: (chat as any).timestamp,
      })),
    );
  }

  private async getMessages(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = cappedLimit(args.limit);
    const id = chatId(args.phone as string | undefined, args.chat_id as string | undefined);
    return ok(await this.getCachedMessages(id, limit));
  }

  private async getContact(args: Record<string, unknown>): Promise<ToolResult> {
    const id = chatId(args.phone as string | undefined);
    const contact: Contact = await this.wa.getContactById(id);
    return ok({
      id: contact.id._serialized,
      name: contact.name,
      pushname: contact.pushname,
      number: contact.number,
      isMyContact: contact.isMyContact,
      isWAContact: contact.isWAContact,
      isBlocked: contact.isBlocked,
      isBusiness: contact.isBusiness,
    });
  }

  private async getGroups(): Promise<ToolResult> {
    const chats = await this.wa.getChats();
    const groups = chats.filter((chat) => chat.isGroup);
    return ok(
      groups.map((group) => ({
        id: group.id._serialized,
        name: group.name,
        participantCount: (group as any).participants?.length ?? null,
      })),
    );
  }

  private async getGroupParticipants(args: Record<string, unknown>): Promise<ToolResult> {
    const chat = (await this.wa.getChatById(args.group_id as string)) as any;
    if (!chat.isGroup) return fail('El chat indicado no es un grupo');

    return ok(
      (chat.participants ?? []).map((participant: any) => ({
        id: participant.id._serialized,
        phone: participant.id.user,
        isAdmin: participant.isAdmin,
        isSuperAdmin: participant.isSuperAdmin,
      })),
    );
  }

  private async searchMessages(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = cappedLimit(args.limit);
    const results = await this.wa.searchMessages(args.query as string, { limit });
    return ok(
      results.map((message) => ({
        id: message.id._serialized,
        from: message.from,
        to: message.to,
        fromMe: message.fromMe,
        body: message.body,
        timestamp: new Date(message.timestamp * 1000).toISOString(),
      })),
    );
  }

  private async markAsRead(args: Record<string, unknown>): Promise<ToolResult> {
    const id = chatId(args.phone as string | undefined, args.chat_id as string | undefined);
    const chat = await this.wa.getChatById(id);
    await chat.sendSeen();
    return ok({ marked: true, chat_id: id });
  }

  private async getUnreadChats(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = cappedLimit(args.limit);
    const chats = await this.wa.getChats();
    const unread = chats.filter((chat) => chat.unreadCount > 0).slice(0, limit);
    return ok(
      unread.map((chat) => ({
        id: chat.id._serialized,
        name: chat.name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        lastMessage: (chat as any).lastMessage?.body?.slice(0, 100) ?? null,
      })),
    );
  }

  private async checkNumberExists(args: Record<string, unknown>): Promise<ToolResult> {
    const phone = (args.phone as string).replace(/\D/g, '');
    const result = await this.wa.isRegisteredUser(`${phone}@c.us`);
    return ok({ phone, exists: result });
  }

  private async getCachedMessages(id: string, limit: number): Promise<MessageSummary[]> {
    const messages = await (this.wa as any).pupPage.evaluate((chatId: string, max: number) => {
      const store = (window as any).Store;
      const wwebjs = (window as any).WWebJS;
      const wid = store.WidFactory.createWid(chatId);
      const chat = store.Chat.get(wid) ?? store.Chat.get(chatId);

      const fromChat = chat?.msgs?.getModelsArray?.() ?? [];
      const fromStore = store.Msg?.getModelsArray?.() ?? [];
      const source = fromChat.length ? fromChat : fromStore;

      const normalizedChatId = typeof wid === 'string' ? wid : wid?._serialized;
      const rows = source
        .filter((message: any) => {
          if (!message || message.isNotification) return false;
          const remote = message.id?.remote?._serialized ?? message.id?.remote ?? message.from ?? message.to;
          return remote === chatId || remote === normalizedChatId;
        })
        .sort((a: any, b: any) => Number(a.t ?? a.timestamp ?? 0) - Number(b.t ?? b.timestamp ?? 0))
        .slice(-max);

      return rows.map((message: any) => {
        const model = wwebjs?.getMessageModel ? wwebjs.getMessageModel(message) : message.serialize?.() ?? message;
        const timestamp = Number(model.timestamp ?? model.t ?? message.t ?? 0);
        const serializeId = (value: any) => value?._serialized ?? value?.serialized ?? value ?? '';

        return {
          id: model.id?._serialized ?? model.id?.id ?? message.id?._serialized ?? '',
          from: serializeId(model.from ?? message.from),
          to: serializeId(model.to ?? message.to),
          fromMe: Boolean(model.fromMe ?? message.id?.fromMe),
          body: model.body ?? model.caption ?? message.body ?? message.caption ?? '',
          type: model.type ?? message.type ?? '',
          timestamp: timestamp ? new Date(timestamp * 1000).toISOString() : null,
          hasMedia: Boolean(model.hasMedia ?? message.isMedia),
        };
      });
    }, id, limit);

    return messages as MessageSummary[];
  }
}
