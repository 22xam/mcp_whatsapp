import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../data/database.service';

export interface ConversationMemoryContext {
  summary?: string;
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  unsummarizedCount: number;
}

interface MessageRow {
  id: string;
  sender_id: string;
  role: 'user' | 'assistant';
  content: string;
  summarized: number;
  created_at: string;
}

interface SummaryRow {
  sender_id: string;
  summary: string;
  message_count: number;
  updated_at: string;
}

@Injectable()
export class ConversationMemoryService {
  constructor(private readonly database: DatabaseService) {}

  record(senderId: string, role: 'user' | 'assistant', content: string): void {
    this.database.connection
      .prepare(`
        INSERT INTO conversation_messages (id, sender_id, role, content, summarized, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
      `)
      .run(randomUUID(), senderId, role, content, new Date().toISOString());
  }

  getContext(senderId: string, recentLimit = 12): ConversationMemoryContext {
    const summary = this.database.connection
      .prepare('SELECT * FROM conversation_summaries WHERE sender_id = ?')
      .get(senderId) as SummaryRow | undefined;
    const recentRows = this.database.connection
      .prepare('SELECT * FROM conversation_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(senderId, recentLimit) as MessageRow[];
    const unsummarized = this.database.connection
      .prepare('SELECT COUNT(*) as n FROM conversation_messages WHERE sender_id = ? AND summarized = 0')
      .get(senderId) as { n: number };

    return {
      summary: summary?.summary,
      recentMessages: recentRows
        .reverse()
        .map((row) => ({ role: row.role, content: row.content })),
      unsummarizedCount: unsummarized.n,
    };
  }

  getUnsummarizedMessages(senderId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
    const rows = this.database.connection
      .prepare('SELECT * FROM conversation_messages WHERE sender_id = ? AND summarized = 0 ORDER BY created_at')
      .all(senderId) as MessageRow[];
    return rows.map((row) => ({ role: row.role, content: row.content }));
  }

  getSummary(senderId: string): string | undefined {
    const row = this.database.connection
      .prepare('SELECT summary FROM conversation_summaries WHERE sender_id = ?')
      .get(senderId) as { summary: string } | undefined;
    return row?.summary;
  }

  saveSummary(senderId: string, summary: string, messageCount: number): void {
    const now = new Date().toISOString();
    this.database.connection
      .prepare(`
        INSERT INTO conversation_summaries (sender_id, summary, message_count, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sender_id) DO UPDATE SET
          summary = excluded.summary,
          message_count = conversation_summaries.message_count + excluded.message_count,
          updated_at = excluded.updated_at
      `)
      .run(senderId, summary, messageCount, now);
    this.database.connection
      .prepare('UPDATE conversation_messages SET summarized = 1 WHERE sender_id = ? AND summarized = 0')
      .run(senderId);
  }
}
