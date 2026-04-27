import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AI_PROVIDER } from '../core/tokens/injection-tokens';
import type { AIProvider } from '../core/interfaces/ai-provider.interface';
import { ConfigLoaderService } from '../config/config-loader.service';
import type { CampaignConfig } from '../config/types/campaign.types';
import type { ClientConfig } from '../config/types/bot-config.types';
import { ClientsService } from '../clients/clients.service';
import { AuditService } from '../data/audit.service';
import { DatabaseService } from '../data/database.service';
import { OptOutService } from '../opt-out/opt-out.service';
import { WhatsAppAdapter } from '../messaging/adapters/whatsapp.adapter';

interface CampaignPreviewItem {
  phone: string;
  name?: string;
  skipped?: boolean;
  reason?: string;
  message?: string;
}

interface CampaignRunRow {
  id: string;
  campaign_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  totals_json: string;
}

interface CampaignJobRow {
  id: string;
  run_id: string;
  campaign_id: string;
  phone: string;
  name: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  message: string;
  error: string | null;
  available_at: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private readonly configLoader: ConfigLoaderService,
    private readonly clientsService: ClientsService,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly optOutService: OptOutService,
    private readonly whatsAppAdapter: WhatsAppAdapter,
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
  ) {}

  listCampaigns(): CampaignConfig[] {
    return this.configLoader.campaigns;
  }

  getCampaign(id: string): CampaignConfig | null {
    return this.configLoader.campaigns.find((campaign) => campaign.id === id) ?? null;
  }

  patchCampaign(id: string, patch: Partial<Pick<CampaignConfig, 'enabled' | 'messageMode' | 'template' | 'aiPrompt' | 'systemPrompt'>>): CampaignConfig {
    return this.configLoader.updateCampaign(id, patch);
  }

  async preview(campaignId: string, phones?: string[], limit = 10): Promise<CampaignPreviewItem[]> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    const targets = this.resolveTargets(campaign, phones).slice(0, limit);
    const items: CampaignPreviewItem[] = [];
    this.logger.log(`Preview campaign "${campaign.id}" for ${targets.length} target(s)`);

    const renderTasks = targets.map(async (client, index) => {
      if (this.optOutService.isOptedOut(client.phone)) {
        this.logger.debug(`Preview ${index + 1}/${targets.length} skipped ${client.phone} (${client.name}) — opt-out`);
        return { phone: client.phone, name: client.name, skipped: true, reason: 'opt-out' } as CampaignPreviewItem;
      }
      this.logger.debug(`Preview ${index + 1}/${targets.length} rendering ${client.phone} (${client.name})`);
      return {
        phone: client.phone,
        name: client.name,
        message: await this.renderMessage(campaign, client),
      } as CampaignPreviewItem;
    });

    return Promise.all(renderTasks);
  }

  async createRun(campaignId: string, phones?: string[], dryRun = false) {
    const startedAt = Date.now();
    const campaign = this.requireCampaign(campaignId);
    const runId = randomUUID();
    const now = new Date().toISOString();
    const targets = this.resolveTargets(campaign, phones);
    const maxPerRun = campaign.rateLimit?.maxPerRun ?? targets.length;
    const selected = targets.slice(0, maxPerRun);
    let queued = 0;
    let skipped = 0;
    let failed = 0;

    this.logger.log(
      `Creating campaign run ${runId} for "${campaign.id}" (${campaign.name}) — ` +
        `targets=${targets.length}, selected=${selected.length}, dryRun=${dryRun}`,
    );

    const insertRun = this.database.connection.prepare(`
      INSERT INTO campaign_runs (id, campaign_id, status, created_at, updated_at, totals_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertJob = this.database.connection.prepare(`
      INSERT INTO campaign_jobs (
        id, run_id, campaign_id, phone, name, status, attempts, max_attempts,
        message, error, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.database.connection.transaction(() => {
      insertRun.run(runId, campaign.id, dryRun ? 'dry_run' : 'queued', now, now, '{}');
    });
    tx();

    for (const [index, client] of selected.entries()) {
      const optedOut = this.optOutService.isOptedOut(client.phone);
      const status = dryRun ? 'preview' : optedOut ? 'skipped' : 'queued';
      if (status === 'queued') queued++;
      if (status === 'skipped') skipped++;
      this.logger.debug(
        `Run ${runId}: preparing ${index + 1}/${selected.length} ` +
          `${client.phone} (${client.name}) status=${status}`,
      );

      let message: string;
      try {
        message = await this.renderMessage(campaign, client, {
          runId,
          index: index + 1,
          total: selected.length,
        });
      } catch (error) {
        failed++;
        if (status === 'queued') queued--;
        if (status === 'skipped') skipped--;
        this.logger.error(
          `Run ${runId}: failed rendering ${index + 1}/${selected.length} ` +
            `${client.phone} (${client.name}): ${(error as Error).message}`,
        );
        message = '';
      }

      const finalStatus = message ? status : 'failed';
      insertJob.run(
        randomUUID(),
        runId,
        campaign.id,
        client.phone,
        client.name,
        finalStatus,
        campaign.retry?.maxAttempts ?? 3,
        message,
        optedOut ? 'opt-out' : message ? null : 'render_failed',
        now,
        now,
        now,
      );
      this.logger.debug(
        `Run ${runId}: job inserted for ${client.phone} status=${finalStatus} messageChars=${message.length}`,
      );
    }

    this.updateRunTotals(runId, { queued, skipped, failed, total: selected.length });
    this.audit.record({
      entityType: 'campaign_run',
      entityId: runId,
      action: dryRun ? 'dry_run_created' : 'created',
      source: 'api',
      metadata: { campaignId: campaign.id, queued, skipped, failed, total: selected.length },
    });
    this.logger.log(
      `Campaign run ${runId} created in ${Date.now() - startedAt}ms — ` +
        `queued=${queued}, skipped=${skipped}, failed=${failed}, total=${selected.length}`,
    );
    return this.getRun(runId);
  }

  getRun(runId: string) {
    const run = this.database.connection
      .prepare('SELECT * FROM campaign_runs WHERE id = ?')
      .get(runId) as CampaignRunRow | undefined;
    if (!run) return null;

    const jobs = this.database.connection
      .prepare('SELECT * FROM campaign_jobs WHERE run_id = ? ORDER BY created_at')
      .all(runId) as CampaignJobRow[];

    return {
      id: run.id,
      campaignId: run.campaign_id,
      status: run.status,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      totals: this.parseJson(run.totals_json, {}),
      jobs: jobs.map((job) => ({
        id: job.id,
        phone: job.phone,
        name: job.name ?? undefined,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        message: job.message,
        error: job.error ?? undefined,
        availableAt: job.available_at,
      })),
    };
  }

  listRuns(filters: { status?: string; campaignId?: string } = {}) {
    const runs = this.database.connection
      .prepare('SELECT * FROM campaign_runs ORDER BY created_at DESC')
      .all() as CampaignRunRow[];
    return runs
      .filter((run) => !filters.status || run.status === filters.status)
      .filter((run) => !filters.campaignId || run.campaign_id === filters.campaignId)
      .map((run) => ({
        id: run.id,
        campaignId: run.campaign_id,
        status: run.status,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        totals: this.parseJson(run.totals_json, {}),
      }));
  }

  setRunStatus(runId: string, status: 'queued' | 'paused' | 'cancelled') {
    this.database.connection
      .prepare('UPDATE campaign_runs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), runId);
    if (status === 'cancelled') {
      this.database.connection
        .prepare("UPDATE campaign_jobs SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND status = 'queued'")
        .run(new Date().toISOString(), runId);
    }
    this.audit.record({
      entityType: 'campaign_run',
      entityId: runId,
      action: status,
      source: 'api',
    });
    return this.getRun(runId);
  }

  async processNextQueuedJob(runId: string) {
    const startedAt = Date.now();
    const run = this.database.connection
      .prepare('SELECT * FROM campaign_runs WHERE id = ?')
      .get(runId) as CampaignRunRow | undefined;
    if (!run) throw new Error(`Campaign run not found: ${runId}`);
    if (run.status === 'paused' || run.status === 'cancelled' || run.status === 'completed') {
      this.logger.debug(`Run ${runId}: process skipped because status=${run.status}`);
      return this.getRun(runId);
    }
    if (run.status === 'queued') {
      this.database.connection
        .prepare('UPDATE campaign_runs SET status = ?, updated_at = ? WHERE id = ?')
        .run('running', new Date().toISOString(), runId);
    }

    const nowIso = new Date().toISOString();
    const job = this.database.connection
      .prepare(
        "SELECT * FROM campaign_jobs WHERE run_id = ? AND status = 'queued' AND available_at <= ? ORDER BY available_at, created_at LIMIT 1",
      )
      .get(runId, nowIso) as CampaignJobRow | undefined;
    if (!job) {
      const pending = this.database.connection
        .prepare("SELECT COUNT(*) as n FROM campaign_jobs WHERE run_id = ? AND status IN ('queued', 'sending')")
        .get(runId) as { n: number };
      if (pending.n === 0) {
        this.database.connection
          .prepare('UPDATE campaign_runs SET status = ?, updated_at = ? WHERE id = ?')
          .run('completed', new Date().toISOString(), runId);
        this.audit.record({
          entityType: 'campaign_run',
          entityId: runId,
          action: 'completed',
          source: 'campaign_worker',
        });
        this.logger.log(`Run ${runId}: completed, no queued jobs remain`);
      } else {
        this.logger.debug(`Run ${runId}: no job available yet, pending=${pending.n}`);
      }
      this.recomputeRunTotals(runId);
      return this.getRun(runId);
    }

    const now = new Date().toISOString();
    this.database.connection
      .prepare("UPDATE campaign_jobs SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .run(now, job.id);
    this.logger.log(
      `Run ${runId}: sending job ${job.id} to ${job.phone} attempt=${job.attempts + 1}/${job.max_attempts}`,
    );

    try {
      await this.sendJobMessage(job.phone, job.message, job.campaign_id);
      this.database.connection
        .prepare("UPDATE campaign_jobs SET status = 'sent', error = NULL, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), job.id);
      this.audit.record({
        entityType: 'campaign_job',
        entityId: job.id,
        action: 'sent',
        source: 'campaign_worker',
        metadata: { runId, phone: job.phone },
      });
      this.logger.log(`Run ${runId}: job ${job.id} sent to ${job.phone} in ${Date.now() - startedAt}ms`);
    } catch (error) {
      const attempts = job.attempts + 1;
      const status = attempts >= job.max_attempts ? 'failed' : 'queued';
      const retryAt = this.nextRetryAt(job.campaign_id);
      this.database.connection
        .prepare('UPDATE campaign_jobs SET status = ?, error = ?, available_at = ?, updated_at = ? WHERE id = ?')
        .run(status, (error as Error).message, retryAt, new Date().toISOString(), job.id);
      this.audit.record({
        entityType: 'campaign_job',
        entityId: job.id,
        action: status === 'failed' ? 'failed' : 'retry_queued',
        source: 'campaign_worker',
        metadata: { runId, phone: job.phone, error: (error as Error).message },
      });
      this.logger.warn(`Campaign job ${job.id} failed: ${(error as Error).message}`);
    }

    this.recomputeRunTotals(runId);
    return this.getRun(runId);
  }

  getActiveRunIds(): string[] {
    const rows = this.database.connection
      .prepare("SELECT id FROM campaign_runs WHERE status IN ('queued', 'running') ORDER BY created_at")
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getRateLimitDelayMs(campaignId: string): number {
    return Math.max(this.getCampaign(campaignId)?.rateLimit?.delayMs ?? 0, 0);
  }

  getRunCampaignId(runId: string): string | null {
    const row = this.database.connection
      .prepare('SELECT campaign_id FROM campaign_runs WHERE id = ?')
      .get(runId) as { campaign_id: string } | undefined;
    return row?.campaign_id ?? null;
  }

  private async sendJobMessage(phone: string, message: string, campaignId: string): Promise<void> {
    const PART_SEPARATOR = '\n---\n';
    const parts = message.split(PART_SEPARATOR).map((p) => p.trim()).filter(Boolean);
    const recipientId = `${phone}@c.us`;

    if (parts.length <= 1) {
      await this.whatsAppAdapter.sendBroadcast(recipientId, message);
      return;
    }

    // Entre partes del mismo mensaje usamos el delay mínimo anti-spam (no el máximo)
    // para que lleguen juntas pero con una pausa natural entre burbujas
    const as = this.configLoader.antispam;
    const interPartDelayMs = Math.max(as.delayMin_ms, this.getCampaign(campaignId)?.rateLimit?.delayMs ?? 0);

    for (let i = 0; i < parts.length; i++) {
      await this.whatsAppAdapter.sendBroadcast(recipientId, parts[i]);
      if (i < parts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, interPartDelayMs));
      }
    }
  }

  private requireCampaign(id: string): CampaignConfig {
    const campaign = this.getCampaign(id);
    if (!campaign) throw new Error(`Campaign not found: ${id}`);
    if (!campaign.enabled) throw new Error(`Campaign disabled: ${id}`);
    return campaign;
  }

  private resolveTargets(campaign: CampaignConfig, phones?: string[]): ClientConfig[] {
    const clients = this.clientsService.findAll();
    const requested = phones?.map((phone) => phone.replace(/\D/g, ''));
    if (requested?.length) {
      return clients.filter((client) => requested.includes(client.phone.replace(/\D/g, '')));
    }

    switch (campaign.audience.mode) {
      case 'phones':
        return clients.filter((client) => campaign.audience.phones?.includes(client.phone));
      case 'systems':
        return clients.filter((client) =>
          client.systems.some((system) => campaign.audience.systems?.includes(system)),
        );
      case 'companies':
        return clients.filter((client) => campaign.audience.companies?.includes(client.company));
      case 'tags':
        return clients.filter((client) =>
          (client.tags ?? []).some((tag) => campaign.audience.tags?.includes(tag)),
        );
      default:
        return clients;
    }
  }

  private resolveMessageMode(campaign: CampaignConfig): 'ai' | 'template' {
    if (campaign.messageMode) return campaign.messageMode;
    if (campaign.template) return 'template';
    return 'ai';
  }

  private async renderMessage(
    campaign: CampaignConfig,
    client: ClientConfig,
    context?: { runId?: string; index?: number; total?: number },
  ): Promise<string> {
    const startedAt = Date.now();
    const prefix = context?.runId
      ? `Run ${context.runId}: render ${context.index}/${context.total} ${client.phone}`
      : `Render campaign "${campaign.id}" ${client.phone}`;
    const vars = {
      phone: client.phone,
      name: client.name,
      company: client.company,
      systems: client.systems.join(', '),
      tags: (client.tags ?? []).join(', '),
    };

    const mode = this.resolveMessageMode(campaign);

    if (mode === 'template') {
      if (!campaign.template) {
        throw new Error(`Campaign "${campaign.id}" tiene messageMode='template' pero no tiene campo 'template' definido.`);
      }
      const rendered = this.interpolate(campaign.template, vars);
      this.logger.debug(`${prefix} mode=template completed in ${Date.now() - startedAt}ms chars=${rendered.length}`);
      return rendered;
    }

    const prompt = this.interpolate(campaign.aiPrompt ?? 'Escribi un mensaje breve para {name}.', vars);
    this.logger.log(`${prefix} mode=ai provider=${this.aiProvider.providerName} promptChars=${prompt.length}`);
    const slowTimer = setTimeout(() => {
      this.logger.warn(`${prefix} still waiting for AI after ${Date.now() - startedAt}ms`);
    }, 15000);
    try {
      const response = await this.aiProvider.generate({
        prompt,
        systemPrompt: campaign.systemPrompt ?? 'Escribi mensajes breves y naturales para WhatsApp.',
      });
      const text = response.text.trim();
      this.logger.log(
        `${prefix} mode=ai completed in ${Date.now() - startedAt}ms ` +
          `chars=${text.length} model=${String(response.metadata?.model ?? response.metadata?.winnerModel ?? 'unknown')}`,
      );
      return text;
    } finally {
      clearTimeout(slowTimer);
    }
  }

  private updateRunTotals(runId: string, totals: Record<string, unknown>): void {
    this.database.connection
      .prepare('UPDATE campaign_runs SET totals_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(totals), new Date().toISOString(), runId);
  }

  private recomputeRunTotals(runId: string): void {
    const rows = this.database.connection
      .prepare('SELECT status, COUNT(*) as n FROM campaign_jobs WHERE run_id = ? GROUP BY status')
      .all(runId) as Array<{ status: string; n: number }>;
    const totals = Object.fromEntries(rows.map((row) => [row.status, row.n]));
    totals.total = rows.reduce((sum, row) => sum + row.n, 0);
    this.updateRunTotals(runId, totals);
  }

  private interpolate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private nextRetryAt(campaignId: string): string {
    const backoffMs = Math.max(this.getCampaign(campaignId)?.retry?.backoffMs ?? 0, 0);
    return new Date(Date.now() + backoffMs).toISOString();
  }
}
