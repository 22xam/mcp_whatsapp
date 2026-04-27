import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface StoredMessage {
  id: string;
  direction: 'in' | 'out';
  senderId: string;
  senderName?: string;
  text: string;
  mediaType?: string;
  timestamp: number;
}

@Injectable()
export class MessageStoreService {
  private readonly maxMessages = 500;
  private readonly messages: StoredMessage[] = [];
  readonly events$ = new Subject<StoredMessage>();

  push(msg: Omit<StoredMessage, 'id'>): StoredMessage {
    const stored: StoredMessage = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...msg };
    this.messages.push(stored);
    if (this.messages.length > this.maxMessages) this.messages.shift();
    this.events$.next(stored);
    return stored;
  }

  getAll(senderId?: string, limit = 200): StoredMessage[] {
    const src = senderId ? this.messages.filter((m) => m.senderId === senderId) : this.messages;
    return src.slice(-limit);
  }

  getSenders(): { senderId: string; senderName?: string; lastTs: number }[] {
    const map = new Map<string, { senderId: string; senderName?: string; lastTs: number }>();
    for (const m of this.messages) {
      const existing = map.get(m.senderId);
      if (!existing || m.timestamp > existing.lastTs) {
        map.set(m.senderId, { senderId: m.senderId, senderName: m.senderName, lastTs: m.timestamp });
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
  }
}
