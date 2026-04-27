import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from './database.service';

export interface AuditEvent {
  id: string;
  entityType: string;
  entityId?: string;
  action: string;
  actor: string;
  source?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface AuditEventRow {
  id: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  actor: string;
  source: string | null;
  metadata_json: string;
  created_at: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  record(event: {
    entityType: string;
    entityId?: string;
    action: string;
    actor?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }): AuditEvent {
    const auditEvent: AuditEvent = {
      id: randomUUID(),
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      actor: event.actor ?? 'system',
      source: event.source,
      metadata: event.metadata ?? {},
      createdAt: new Date().toISOString(),
    };

    this.database.connection
      .prepare(`
        INSERT INTO audit_events (
          id, entity_type, entity_id, action, actor, source, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        auditEvent.id,
        auditEvent.entityType,
        auditEvent.entityId ?? null,
        auditEvent.action,
        auditEvent.actor,
        auditEvent.source ?? null,
        JSON.stringify(auditEvent.metadata),
        auditEvent.createdAt,
      );

    return auditEvent;
  }

  list(limit = 100, filters: { entityType?: string; action?: string } = {}): AuditEvent[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = this.database.connection
      .prepare('SELECT * FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(safeLimit) as AuditEventRow[];

    return rows
      .filter((row) => !filters.entityType || row.entity_type === filters.entityType)
      .filter((row) => !filters.action || row.action === filters.action)
      .map((row) => ({
        id: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id ?? undefined,
        action: row.action,
        actor: row.actor,
        source: row.source ?? undefined,
        metadata: this.parseJson(row.metadata_json),
        createdAt: row.created_at,
      }));
  }

  private parseJson(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
