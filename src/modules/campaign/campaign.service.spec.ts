import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CampaignService } from './campaign.service';
import { AuditService } from '../data/audit.service';
import { DatabaseService } from '../data/database.service';
import type { CampaignConfig } from '../config/types/campaign.types';

describe('CampaignService', () => {
  type CampaignRunDetails = NonNullable<
    Awaited<ReturnType<CampaignService['createRun']>>
  >;
  type CampaignJobDetails = CampaignRunDetails['jobs'][number];

  const originalEnv = process.env;
  let tempDir: string;
  let database: DatabaseService;
  let service: CampaignService;
  let whatsAppAdapter: { sendBroadcast: jest.Mock };
  let optOutService: { isOptedOut: jest.Mock };

  const campaign: CampaignConfig = {
    id: 'welcome',
    name: 'Welcome',
    enabled: true,
    audience: { mode: 'all' },
    template: 'Hola {name}',
    rateLimit: { delayMs: 100, maxPerRun: 10 },
    retry: { maxAttempts: 2, backoffMs: 5000 },
  };

  const clients = [
    {
      phone: '5491111111111',
      name: 'Ana',
      company: 'ACME',
      systems: ['crm'],
      tags: ['cliente-activo'],
    },
    {
      phone: '5492222222222',
      name: 'Luis',
      company: 'ACME',
      systems: ['erp'],
      tags: ['prospecto'],
    },
  ];

  function expectRun(run: CampaignRunDetails | null): CampaignRunDetails {
    expect(run).not.toBeNull();
    return run as CampaignRunDetails;
  }

  function expectJob(job: CampaignJobDetails | undefined): CampaignJobDetails {
    expect(job).toBeDefined();
    return job as CampaignJobDetails;
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    tempDir = mkdtempSync(join(tmpdir(), 'bot-oscar-campaign-'));
    process.env.BOT_OSCAR_DB_PATH = join(tempDir, 'bugmate.sqlite');

    database = new DatabaseService();
    database.onModuleInit();
    whatsAppAdapter = { sendBroadcast: jest.fn().mockResolvedValue(undefined) };
    optOutService = { isOptedOut: jest.fn().mockReturnValue(false) };

    service = new CampaignService(
      { campaigns: [campaign] } as any,
      { findAll: jest.fn().mockReturnValue(clients) } as any,
      database,
      new AuditService(database),
      optOutService as any,
      whatsAppAdapter as any,
      { generate: jest.fn() } as any,
    );
  });

  afterEach(() => {
    database.connection.close();
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('creates queued jobs from a template campaign', async () => {
    const run = expectRun(await service.createRun('welcome'));

    expect(run).toMatchObject({
      campaignId: 'welcome',
      status: 'queued',
      totals: { queued: 2, skipped: 0, total: 2 },
    });
    // Ana (digit-sum 28, 28%4=0) → 'Hola Ana'; Luis (digit-sum 38, 38%4=2) → 'Buen día Luis'
    expect(run.jobs.map((job) => job.message)).toEqual([
      'Hola Ana',
      'Buen día Luis',
    ]);
  });

  it('creates preview jobs for dry runs', async () => {
    const run = expectRun(await service.createRun('welcome', undefined, true));

    expect(run.status).toBe('dry_run');
    expect(run.jobs.every((job) => job.status === 'preview')).toBe(true);
  });

  it('sends the next queued job and recomputes totals', async () => {
    const created = expectRun(await service.createRun('welcome'));
    const run = expectRun(await service.processNextQueuedJob(created.id));

    expect(whatsAppAdapter.sendBroadcast).toHaveBeenCalledWith(
      '5491111111111@c.us',
      'Hola Ana',
    );
    expect(run.totals).toMatchObject({ sent: 1, queued: 1, total: 2 });
  });

  it('requeues failed jobs with backoff before final failure', async () => {
    whatsAppAdapter.sendBroadcast.mockRejectedValueOnce(
      new Error('network down'),
    );
    const created = expectRun(await service.createRun('welcome'));
    const run = expectRun(await service.processNextQueuedJob(created.id));
    const failedJob = expectJob(
      run.jobs.find((job) => job.phone === '5491111111111'),
    );

    expect(failedJob).toMatchObject({
      status: 'queued',
      attempts: 1,
      error: 'network down',
    });
    expect(new Date(failedJob.availableAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('sets lastSendError to null after a successful send', async () => {
    const created = expectRun(await service.createRun('welcome'));
    await service.processNextQueuedJob(created.id);

    expect(service.lastSendError).toBeNull();
  });

  it('sets lastSendError to an Error instance after a failed send', async () => {
    whatsAppAdapter.sendBroadcast.mockRejectedValueOnce(
      new Error('network down'),
    );
    const created = expectRun(await service.createRun('welcome'));
    await service.processNextQueuedJob(created.id);

    expect(service.lastSendError).toBeInstanceOf(Error);
    expect(service.lastSendError?.message).toBe('network down');
  });

  it('varyOpeningGreeting produces different greetings for different phone numbers', async () => {
    const run = expectRun(await service.createRun('welcome'));
    const messages = run.jobs.map((job) => job.message);

    // Ana gets 'Hola', Luis gets 'Buen día' — same template, different outputs
    expect(messages[0]).toMatch(/^Hola /);
    expect(messages[1]).toMatch(/^Buen día /);
  });

  it('segments campaign audiences by tags', async () => {
    const taggedCampaign = {
      ...campaign,
      id: 'tagged',
      audience: { mode: 'tags' as const, tags: ['cliente-activo'] },
    };
    service = new CampaignService(
      { campaigns: [taggedCampaign] } as any,
      { findAll: jest.fn().mockReturnValue(clients) } as any,
      database,
      new AuditService(database),
      optOutService as any,
      whatsAppAdapter as any,
      { generate: jest.fn() } as any,
    );

    const run = expectRun(await service.createRun('tagged'));

    expect(run.jobs).toHaveLength(1);
    expect(run.jobs[0]).toMatchObject({ phone: '5491111111111', name: 'Ana' });
  });
});
