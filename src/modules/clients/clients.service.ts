import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigLoaderService } from '../config/config-loader.service';
import type { ClientConfig } from '../config/types/bot-config.types';
import { AuditService } from '../data/audit.service';
import { ClientsRepository } from './clients.repository';

@Injectable()
export class ClientsService implements OnModuleInit {
  constructor(
    private readonly repository: ClientsRepository,
    private readonly configLoader: ConfigLoaderService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (this.repository.count() === 0) {
      this.repository.seed(this.configLoader.clients);
      this.audit.record({
        entityType: 'clients',
        action: 'seed_from_config',
        metadata: { count: this.configLoader.clients.length },
      });
    }
  }

  findAll(): ClientConfig[] {
    return this.repository.findAll();
  }

  search(filters: { q?: string; tag?: string; system?: string } = {}): ClientConfig[] {
    const q = this.normalizeSearch(filters.q);
    const tag = this.normalizeSearch(filters.tag);
    const system = this.normalizeSearch(filters.system);

    return this.findAll().filter((client) => {
      const matchesQuery =
        !q ||
        [client.phone, client.name, client.company, client.notes, ...(client.tags ?? []), ...(client.systems ?? [])]
          .filter(Boolean)
          .some((value) => this.normalizeSearch(String(value)).includes(q));
      const matchesTag = !tag || (client.tags ?? []).some((value) => this.normalizeSearch(value) === tag);
      const matchesSystem = !system || client.systems.some((value) => this.normalizeSearch(value) === system);
      return matchesQuery && matchesTag && matchesSystem;
    });
  }

  findByPhone(phone: string): ClientConfig | null {
    return this.repository.findByPhone(phone);
  }

  upsert(client: ClientConfig): ClientConfig {
    const normalizedClient = this.normalizeClient(client);
    const existed = Boolean(this.repository.findByPhone(normalizedClient.phone));
    const saved = this.repository.upsert(normalizedClient);
    this.audit.record({
      entityType: 'client',
      entityId: saved.phone,
      action: existed ? 'updated' : 'created',
      source: 'api',
      metadata: { name: saved.name, company: saved.company },
    });
    return saved;
  }

  delete(phone: string): boolean {
    const normalized = this.repository.normalizePhone(phone);
    const deleted = this.repository.delete(phone);
    if (deleted) {
      this.audit.record({
        entityType: 'client',
        entityId: normalized,
        action: 'deleted',
        source: 'api',
      });
    }
    return deleted;
  }

  importPreview(clients: ClientConfig[]) {
    const existing = new Set(this.findAll().map((c) => c.phone));
    return clients.map((client) => {
      const phone = this.repository.normalizePhone(client.phone);
      const missing: string[] = [];
      if (!phone) missing.push('phone');
      if (!client.name) missing.push('name');
      return {
        phone,
        name: client.name,
        company: client.company ?? '',
        systems: client.systems ?? [],
        tags: client.tags ?? [],
        valid: missing.length === 0,
        errors: missing,
        action: existing.has(phone) ? 'update' : 'create',
      };
    });
  }

  importCommit(clients: ClientConfig[]) {
    const preview = this.importPreview(clients);
    const invalid = preview.filter((item) => !item.valid);
    if (invalid.length > 0) {
      return { imported: 0, invalid, clients: [] };
    }

    const results = clients.map((client) => this.upsert(this.normalizeClient(client)));
    this.audit.record({
      entityType: 'clients',
      action: 'import_committed',
      source: 'api',
      metadata: { count: results.length },
    });
    return { imported: results.length, clients: results };
  }

  parseCsv(csv: string): ClientConfig[] {
    const rows = this.parseCsvRows(csv).filter((row) => row.some((cell) => cell.trim()));
    if (rows.length === 0) return [];

    const headers = rows[0].map((header) => this.normalizeHeader(header));
    return rows.slice(1).map((row) => {
      const record = Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim() ?? '']));
      return this.normalizeClient({
        phone: record.phone ?? record.telefono ?? record.number ?? '',
        name: record.name ?? record.nombre ?? '',
        company: record.company ?? record.empresa ?? '',
        systems: this.splitList(record.systems ?? record.sistemas ?? ''),
        tags: this.splitList(record.tags ?? record.etiquetas ?? ''),
        notes: record.notes ?? record.notas ?? undefined,
        knowledgeDocs: this.splitList(record.knowledge_docs ?? record.knowledgeDocs ?? ''),
        trelloLists: this.parseObject(record.trello_lists ?? record.trelloLists ?? ''),
      });
    });
  }

  private normalizeClient(client: ClientConfig): ClientConfig {
    return {
      phone: this.repository.normalizePhone(client.phone ?? ''),
      name: client.name ?? '',
      company: client.company ?? '',
      systems: this.uniqueList(client.systems ?? []),
      tags: this.uniqueList(client.tags ?? []),
      notes: client.notes,
      knowledgeDocs: this.uniqueList(client.knowledgeDocs ?? []),
      trelloLists: client.trelloLists ?? {},
    };
  }

  private parseCsvRows(csv: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < csv.length; index++) {
      const char = csv[index];
      const next = csv[index + 1];
      if (char === '"' && quoted && next === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        row.push(cell);
        cell = '';
      } else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && next === '\n') index++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }

    row.push(cell);
    rows.push(row);
    return rows;
  }

  private splitList(value: string): string[] {
    return this.uniqueList(value.split(/[;|,]/g));
  }

  private uniqueList(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private normalizeHeader(header: string): string {
    return header.trim().replace(/^\uFEFF/, '').replace(/\s+/g, '_').toLowerCase();
  }

  private normalizeSearch(value: string | undefined): string {
    return (value ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private parseObject(value: string): Record<string, string> {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}
