import { Injectable } from '@nestjs/common';
import { AuditService } from '../data/audit.service';
import { DatabaseService } from '../data/database.service';

export interface OptOutEntry {
  phone: string;
  reason?: string;
  source: string;
  createdAt: string;
}

interface OptOutRow {
  phone: string;
  reason: string | null;
  source: string;
  created_at: string;
}

@Injectable()
export class OptOutService {
  readonly keywords = ['baja', 'stop', 'no quiero', 'no me escribas', 'no recibir'];

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list(): OptOutEntry[] {
    const rows = this.database.connection
      .prepare('SELECT * FROM opt_outs ORDER BY created_at DESC')
      .all() as OptOutRow[];
    return rows.map((row) => ({
      phone: row.phone,
      reason: row.reason ?? undefined,
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  isOptedOut(phone: string): boolean {
    return Boolean(
      this.database.connection
        .prepare('SELECT phone FROM opt_outs WHERE phone = ?')
        .get(this.normalizePhone(phone)),
    );
  }

  add(phone: string, reason?: string, source = 'manual'): OptOutEntry {
    const normalized = this.normalizePhone(phone);
    const createdAt = new Date().toISOString();
    this.database.connection
      .prepare(`
        INSERT INTO opt_outs (phone, reason, source, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          reason = excluded.reason,
          source = excluded.source,
          created_at = excluded.created_at
      `)
      .run(normalized, reason ?? null, source, createdAt);
    this.audit.record({
      entityType: 'opt_out',
      entityId: normalized,
      action: 'added',
      source,
      metadata: { reason },
    });
    return { phone: normalized, reason, source, createdAt };
  }

  remove(phone: string): boolean {
    const normalized = this.normalizePhone(phone);
    const result = this.database.connection
      .prepare('DELETE FROM opt_outs WHERE phone = ?')
      .run(normalized);
    const removed = result.changes > 0;
    if (removed) {
      this.audit.record({
        entityType: 'opt_out',
        entityId: normalized,
        action: 'removed',
        source: 'api',
      });
    }
    return removed;
  }

  matches(text: string | undefined): boolean {
    const normalized = this.normalize(text);
    return this.keywords.some((keyword) => normalized.includes(this.normalize(keyword)));
  }

  normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  private normalize(text: string | undefined): string {
    return (text ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }
}
