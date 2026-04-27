import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../data/database.service';
import type { ClientConfig } from '../config/types/bot-config.types';

interface ClientRow {
  phone: string;
  name: string;
  company: string;
  systems_json: string;
  tags_json: string;
  knowledge_docs_json: string;
  trello_lists_json: string;
  notes: string | null;
}

@Injectable()
export class ClientsRepository {
  constructor(private readonly database: DatabaseService) {}

  findAll(): ClientConfig[] {
    const rows = this.database.connection
      .prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE')
      .all() as ClientRow[];
    return rows.map((row) => this.toClient(row));
  }

  findByPhone(phone: string): ClientConfig | null {
    const normalized = this.normalizePhone(phone);
    const row = this.database.connection
      .prepare('SELECT * FROM clients WHERE phone = ?')
      .get(normalized) as ClientRow | undefined;
    return row ? this.toClient(row) : null;
  }

  upsert(client: ClientConfig): ClientConfig {
    const now = new Date().toISOString();
    const normalized = this.normalizePhone(client.phone);
    this.database.connection
      .prepare(`
        INSERT INTO clients (
          phone, name, company, systems_json, tags_json, knowledge_docs_json,
          trello_lists_json, notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          name = excluded.name,
          company = excluded.company,
          systems_json = excluded.systems_json,
          tags_json = excluded.tags_json,
          knowledge_docs_json = excluded.knowledge_docs_json,
          trello_lists_json = excluded.trello_lists_json,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `)
      .run(
        normalized,
        client.name,
        client.company ?? '',
        JSON.stringify(client.systems ?? []),
        JSON.stringify(client.tags ?? []),
        JSON.stringify(client.knowledgeDocs ?? []),
        JSON.stringify(client.trelloLists ?? {}),
        client.notes ?? null,
        now,
        now,
      );

    return this.findByPhone(normalized)!;
  }

  delete(phone: string): boolean {
    const result = this.database.connection
      .prepare('DELETE FROM clients WHERE phone = ?')
      .run(this.normalizePhone(phone));
    return result.changes > 0;
  }

  count(): number {
    return (this.database.connection.prepare('SELECT COUNT(*) as n FROM clients').get() as { n: number }).n;
  }

  seed(clients: ClientConfig[]): void {
    const insert = this.database.connection.transaction((items: ClientConfig[]) => {
      for (const client of items) {
        this.upsert(client);
      }
    });
    insert(clients);
  }

  normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  private toClient(row: ClientRow): ClientConfig {
    return {
      phone: row.phone,
      name: row.name,
      company: row.company,
      systems: this.parseJson<string[]>(row.systems_json, []),
      tags: this.parseJson<string[]>(row.tags_json, []),
      knowledgeDocs: this.parseJson<string[]>(row.knowledge_docs_json, []),
      trelloLists: this.parseJson<Record<string, string>>(row.trello_lists_json, {}),
      notes: row.notes ?? undefined,
    };
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
}
