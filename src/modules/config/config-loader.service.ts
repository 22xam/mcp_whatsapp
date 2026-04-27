import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BotConfig, ClientConfig, KnowledgeEntry } from './types/bot-config.types';
import type { CampaignConfig } from './types/campaign.types';
import type { AntispamConfig } from './types/antispam.types';

/**
 * Loads and validates all JSON configuration files at startup.
 * All other services should inject this instead of reading files directly.
 */
@Injectable()
export class ConfigLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ConfigLoaderService.name);
  private readonly configDir = join(process.cwd(), 'config');

  private _botConfig: BotConfig;
  private _clients: ClientConfig[];
  private _knowledge: KnowledgeEntry[];
  private _knowledgeDocs: Array<{ filename: string; content: string }>;
  private _campaigns: CampaignConfig[];
  private _antispam: AntispamConfig;

  private static readonly ANTISPAM_DEFAULTS: AntispamConfig = {
    delayMin_ms: 4000,
    delayMax_ms: 9000,
    delayFirstContact_ms: 3000,
    maxPerDay: 200,
    maxPerHour: 80,
    pauseAfterBatch: 300000,
    batchSize: 30,
    sendWindowStart: '09:00',
    sendWindowEnd: '20:00',
    maxConsecutiveDays: 3,
    warmupMode: false,
    warmupSchedule: [20, 36, 65, 117, 210, 378, 680],
  };

  onModuleInit(): void {
    this.reloadAll();
  }

  reloadAll(): void {
    this.logger.log('Loading JSON configuration files...');
    this._botConfig = this.loadJson<BotConfig>('bot.config.json');
    this._clients = this.loadJson<ClientConfig[]>('clients.json');
    this._knowledge = this.loadJson<KnowledgeEntry[]>('knowledge.json');
    this._campaigns = this.loadOptionalJson<CampaignConfig[]>('campaigns.json', []);
    this._antispam = this.loadOptionalJson<AntispamConfig>('antispam.json', ConfigLoaderService.ANTISPAM_DEFAULTS);
    this._knowledgeDocs = this.loadKnowledgeDocs();
    this.logger.log(
      `Config loaded — ${this._clients.length} clients, ` +
        `${this._knowledge.length} FAQ entries, ` +
        `${this._knowledgeDocs.length} knowledge docs, ` +
        `${this._campaigns.length} campaigns`,
    );
  }

  get botConfig(): BotConfig {
    return this._botConfig;
  }

  get clients(): ClientConfig[] {
    return this._clients;
  }

  get knowledge(): KnowledgeEntry[] {
    return this._knowledge;
  }

  get knowledgeDocs(): Array<{ filename: string; content: string }> {
    return this._knowledgeDocs;
  }

  get campaigns(): CampaignConfig[] {
    return this._campaigns;
  }

  get antispam(): AntispamConfig {
    return this._antispam;
  }

  updateAntispam(patch: Partial<AntispamConfig>): AntispamConfig {
    this._antispam = { ...this._antispam, ...patch };
    writeFileSync(join(this.configDir, 'antispam.json'), JSON.stringify(this._antispam, null, 2), 'utf-8');
    this.logger.log('antispam.json updated and persisted to disk');
    return this._antispam;
  }

  /**
   * Finds a client by phone number. Strips non-digit characters before comparing.
   */
  findClient(phone: string): ClientConfig | undefined {
    const normalized = phone.replace(/\D/g, '').replace(/^549/, '54');
    return this._clients.find((c) => {
      const clientNorm = c.phone.replace(/\D/g, '').replace(/^549/, '54');
      return clientNorm === normalized || c.phone === phone;
    });
  }

  /**
   * Persists a partial update to a campaign in campaigns.json and refreshes in-memory state.
   */
  updateCampaign(id: string, patch: Partial<CampaignConfig>): CampaignConfig {
    const index = this._campaigns.findIndex((c) => c.id === id);
    if (index === -1) throw new Error(`Campaign not found: ${id}`);
    const updated = { ...this._campaigns[index], ...patch, id } as CampaignConfig;
    this._campaigns = [...this._campaigns.slice(0, index), updated, ...this._campaigns.slice(index + 1)];
    const path = join(this.configDir, 'campaigns.json');
    writeFileSync(path, JSON.stringify(this._campaigns, null, 2), 'utf-8');
    this.logger.log(`Campaign "${id}" updated and persisted to disk`);
    return updated;
  }

  /**
   * Interpolates {placeholders} in a template string with the given values.
   */
  interpolate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
  }

  private loadJson<T>(filename: string): T {
    const path = join(this.configDir, filename);
    if (!existsSync(path)) {
      throw new Error(`Config file not found: ${path}. Make sure it exists.`);
    }
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(`Failed to parse ${filename}: ${(err as Error).message}`);
    }
  }

  private loadOptionalJson<T>(filename: string, fallback: T): T {
    const path = join(this.configDir, filename);
    if (!existsSync(path)) {
      return fallback;
    }
    return this.loadJson<T>(filename);
  }

  private loadKnowledgeDocs(): Array<{ filename: string; content: string }> {
    const docsDir = join(this.configDir, 'knowledge-docs');
    if (!existsSync(docsDir)) return [];

    return readdirSync(docsDir)
      .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
      .map((filename) => ({
        filename,
        content: readFileSync(join(docsDir, filename), 'utf-8'),
      }));
  }
}
