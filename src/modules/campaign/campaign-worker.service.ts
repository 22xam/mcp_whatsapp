import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { ConfigLoaderService } from '../config/config-loader.service';

@Injectable()
export class CampaignWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CampaignWorkerService.name);
  private readonly enabled = process.env['CAMPAIGN_WORKER_ENABLED'] !== 'false';
  private readonly intervalMs = Number(process.env['CAMPAIGN_WORKER_INTERVAL_MS'] ?? 5000);
  private readonly lastProcessedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  // Anti-spam counters — reset diariamente / por hora
  private sentToday = 0;
  private sentThisHour = 0;
  private sentInBatch = 0;
  private lastDayReset = new Date().toDateString();
  private lastHourReset = new Date().getHours();
  private batchPauseUntil = 0;

  constructor(
    private readonly campaignService: CampaignService,
    private readonly configLoader: ConfigLoaderService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.warn('CAMPAIGN_WORKER_ENABLED=false — skipping campaign worker');
      return;
    }

    const safeInterval = Math.max(this.intervalMs, 1000);
    this.timer = setInterval(() => {
      void this.tick();
    }, safeInterval);
    this.logger.log(`Campaign worker started — interval ${safeInterval}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<{ processed: number; activeRuns: number; blocked?: string }> {
    if (this.running) {
      this.logger.debug('Campaign worker tick skipped — previous tick still running');
      return { processed: 0, activeRuns: 0 };
    }
    this.running = true;

    try {
      this.resetCountersIfNeeded();
      const as = this.configLoader.antispam;

      // Ventana horaria
      const windowBlock = this.outsideSendWindow(as.sendWindowStart, as.sendWindowEnd);
      if (windowBlock) {
        this.logger.debug(`Campaign worker: outside send window (${as.sendWindowStart}–${as.sendWindowEnd})`);
        return { processed: 0, activeRuns: 0, blocked: 'send_window' };
      }

      // Límite diario
      if (this.sentToday >= as.maxPerDay) {
        this.logger.warn(`Campaign worker: daily limit reached (${this.sentToday}/${as.maxPerDay})`);
        return { processed: 0, activeRuns: 0, blocked: 'daily_limit' };
      }

      // Límite por hora
      if (this.sentThisHour >= as.maxPerHour) {
        this.logger.warn(`Campaign worker: hourly limit reached (${this.sentThisHour}/${as.maxPerHour})`);
        return { processed: 0, activeRuns: 0, blocked: 'hourly_limit' };
      }

      // Pausa post-batch
      if (Date.now() < this.batchPauseUntil) {
        const remaining = Math.ceil((this.batchPauseUntil - Date.now()) / 1000);
        this.logger.debug(`Campaign worker: batch pause — ${remaining}s remaining`);
        return { processed: 0, activeRuns: 0, blocked: 'batch_pause' };
      }

      const runIds = this.campaignService.getActiveRunIds();
      let processed = 0;
      if (runIds.length > 0) {
        this.logger.debug(`Campaign worker tick — activeRuns=${runIds.length} sentToday=${this.sentToday}/${as.maxPerDay} sentHour=${this.sentThisHour}/${as.maxPerHour}`);
      }

      for (const runId of runIds) {
        // Re-check limits inside loop (may have hit them mid-tick)
        if (this.sentToday >= as.maxPerDay || this.sentThisHour >= as.maxPerHour) break;

        const campaignId = this.campaignService.getRunCampaignId(runId);
        if (!campaignId) {
          this.logger.warn(`Campaign worker found run ${runId} without campaignId`);
          continue;
        }
        if (!this.canProcess(runId, campaignId)) {
          this.logger.debug(`Campaign worker delayed run ${runId} by rate limit`);
          continue;
        }

        await this.campaignService.processNextQueuedJob(runId);
        this.lastProcessedAt.set(runId, Date.now());
        this.sentToday++;
        this.sentThisHour++;
        this.sentInBatch++;
        processed++;

        // Pausa larga post-batch
        if (this.sentInBatch >= as.batchSize) {
          this.sentInBatch = 0;
          this.batchPauseUntil = Date.now() + as.pauseAfterBatch;
          this.logger.log(
            `Campaign worker: batch of ${as.batchSize} sent — pausing ${as.pauseAfterBatch / 1000}s`,
          );
          break;
        }
      }

      if (processed > 0) {
        this.logger.debug(`Campaign worker tick finished — processed=${processed}/${runIds.length}`);
      }

      return { processed, activeRuns: runIds.length };
    } finally {
      this.running = false;
    }
  }

  getCounters() {
    const as = this.configLoader.antispam;
    return {
      sentToday: this.sentToday,
      maxPerDay: as.maxPerDay,
      sentThisHour: this.sentThisHour,
      maxPerHour: as.maxPerHour,
      batchPauseUntil: this.batchPauseUntil > Date.now() ? new Date(this.batchPauseUntil).toISOString() : null,
      sendWindow: `${as.sendWindowStart}–${as.sendWindowEnd}`,
      withinWindow: !this.outsideSendWindow(as.sendWindowStart, as.sendWindowEnd),
    };
  }

  private canProcess(runId: string, campaignId: string): boolean {
    const as = this.configLoader.antispam;
    // Delay gaussiano: base + variación aleatoria entre min y max
    const base = as.delayMin_ms;
    const range = as.delayMax_ms - as.delayMin_ms;
    // Aproximación gaussiana con Box-Muller simplificado
    const u = Math.random() + Math.random() + Math.random() + Math.random();
    const gaussian = (u - 2) / 2; // rango ≈ -1..1
    const jitteredDelay = Math.round(base + range * 0.5 + gaussian * range * 0.3);
    const effectiveDelay = Math.max(
      jitteredDelay,
      this.campaignService.getRateLimitDelayMs(campaignId),
    );
    const last = this.lastProcessedAt.get(runId) ?? 0;
    return Date.now() - last >= effectiveDelay;
  }

  private resetCountersIfNeeded(): void {
    const now = new Date();
    if (now.toDateString() !== this.lastDayReset) {
      this.sentToday = 0;
      this.sentInBatch = 0;
      this.lastDayReset = now.toDateString();
      this.logger.log('Campaign worker: daily counters reset');
    }
    if (now.getHours() !== this.lastHourReset) {
      this.sentThisHour = 0;
      this.lastHourReset = now.getHours();
    }
  }

  private outsideSendWindow(start: string, end: string): boolean {
    const now = new Date();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = sh * 60 + sm;
    const endMinutes = eh * 60 + em;
    return nowMinutes < startMinutes || nowMinutes >= endMinutes;
  }
}
