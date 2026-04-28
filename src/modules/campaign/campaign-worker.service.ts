import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { ConfigLoaderService } from '../config/config-loader.service';
import { WhatsAppAdapter } from '../messaging/adapters/whatsapp.adapter';

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

  // Throttle inteligente
  private consecutiveErrors = 0;
  private readonly ERROR_THRESHOLD = 3;
  private autoPausedAt: number | null = null;

  constructor(
    private readonly campaignService: CampaignService,
    private readonly configLoader: ConfigLoaderService,
    private readonly whatsAppAdapter: WhatsAppAdapter,
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

  /** Procesa un job de una corrida específica ignorando la ventana horaria y los rate-limits.
   *  Pensado para envíos manuales de prueba desde el panel. */
  async tickForced(runId: string): Promise<{ processed: number; blocked?: string }> {
    if (this.running) {
      this.logger.warn(`Campaign worker forced tick skipped — previous tick still running`);
      return { processed: 0, blocked: 'running' };
    }
    this.running = true;
    try {
      this.logger.log(`Campaign worker: FORCED tick for run ${runId} (bypassing send window and rate limits)`);
      await this.campaignService.processNextQueuedJob(runId);
      this.lastProcessedAt.set(runId, Date.now());
      this.sentToday++;
      this.sentThisHour++;
      this.sentInBatch++;
      return { processed: 1 };
    } finally {
      this.running = false;
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

        // Verificar conexión WA antes de intentar enviar
        if (!this.whatsAppAdapter.isConnected) {
          this.logger.warn('Campaign worker: WhatsApp disconnected — auto-pausing all runs');
          await this.pauseAllRunsAndAlert('desconexión de WhatsApp', null);
          break;
        }

        await this.campaignService.processNextQueuedJob(runId);
        this.lastProcessedAt.set(runId, Date.now());

        const sendErr = this.campaignService.lastSendError;
        if (sendErr) {
          this.consecutiveErrors++;
          this.logger.warn(
            `Campaign worker: send error #${this.consecutiveErrors} for run ${runId}: ${sendErr.message}`,
          );
          if (this.isDisconnectionError(sendErr) || this.consecutiveErrors >= this.ERROR_THRESHOLD) {
            const reason = this.isDisconnectionError(sendErr)
              ? 'desconexión de WhatsApp durante el envío'
              : `${this.consecutiveErrors} errores consecutivos de envío`;
            await this.pauseAllRunsAndAlert(reason, sendErr);
            break;
          }
        } else {
          this.consecutiveErrors = 0;
        }

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

  private isDisconnectionError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('session') ||
      msg.includes('disconnected') ||
      msg.includes('closed') ||
      msg.includes('destroyed') ||
      msg.includes('target') ||
      msg.includes('protocol error') ||
      msg.includes('navigation')
    );
  }

  private async pauseAllRunsAndAlert(reason: string, error: Error | null): Promise<void> {
    if (this.autoPausedAt && Date.now() - this.autoPausedAt < 60_000) return; // debounce 1 min
    this.autoPausedAt = Date.now();
    this.consecutiveErrors = 0;

    const runIds = this.campaignService.getActiveRunIds();
    if (runIds.length === 0) return;

    const paused: string[] = [];
    for (const runId of runIds) {
      try {
        await this.campaignService.setRunStatus(runId, 'paused');
        paused.push(runId.slice(0, 8));
      } catch {
        // best effort
      }
    }

    this.logger.warn(`Campaign worker: auto-paused ${paused.length} run(s) — reason: ${reason}`);

    const errorLine = error ? `\n*Error:* ${error.message.slice(0, 120)}` : '';
    const runLine = paused.map((id) => `\`${id}\``).join(', ');
    const waitNote = this.isDisconnectionError(error ?? new Error(''))
      ? 'Reconectá el número y luego reanudá desde el panel.'
      : 'Esperá al menos 15 minutos antes de reanudar.';

    const msg =
      `🚨 *Bot Oscar — Campaña auto-pausada*\n\n` +
      `*Motivo:* ${reason}${errorLine}\n` +
      `*Corridas pausadas:* ${runLine}\n\n` +
      `${waitNote}\n` +
      `Panel → Campañas → Corridas → Reanudar`;

    await this.whatsAppAdapter.sendControlAlert(msg);
  }
}
