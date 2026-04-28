import { CampaignWorkerService } from './campaign-worker.service';

describe('CampaignWorkerService — throttle / auto-pause', () => {
  let service: CampaignWorkerService;

  type MockCampaignService = {
    getActiveRunIds: jest.Mock;
    getRunCampaignId: jest.Mock;
    getRateLimitDelayMs: jest.Mock;
    processNextQueuedJob: jest.Mock;
    setRunStatus: jest.Mock;
    lastSendError: Error | null;
  };

  let campaignService: MockCampaignService;
  let configLoader: { antispam: Record<string, unknown> };
  let whatsAppAdapter: { isConnected: boolean; sendControlAlert: jest.Mock };

  const RUN_ID = 'run-abc-1234';
  const CAMPAIGN_ID = 'welcome';

  const antispam = {
    delayMin_ms: 0,
    delayMax_ms: 0,
    maxPerDay: 1000,
    maxPerHour: 1000,
    pauseAfterBatch: 300_000,
    batchSize: 100,
    sendWindowStart: '00:00',
    sendWindowEnd: '23:59',
  };

  beforeEach(() => {
    campaignService = {
      getActiveRunIds: jest.fn().mockReturnValue([RUN_ID]),
      getRunCampaignId: jest.fn().mockReturnValue(CAMPAIGN_ID),
      getRateLimitDelayMs: jest.fn().mockReturnValue(0),
      processNextQueuedJob: jest.fn().mockImplementation(() => {
        campaignService.lastSendError = null;
        return Promise.resolve(null);
      }),
      setRunStatus: jest.fn().mockResolvedValue(undefined),
      lastSendError: null,
    };
    configLoader = { antispam };
    whatsAppAdapter = {
      isConnected: true,
      sendControlAlert: jest.fn().mockResolvedValue(undefined),
    };
    service = new CampaignWorkerService(
      campaignService as any,
      configLoader as any,
      whatsAppAdapter as any,
    );
  });

  it('resets consecutiveErrors to 0 after a successful send', async () => {
    campaignService.processNextQueuedJob.mockImplementationOnce(() => {
      campaignService.lastSendError = new Error('timeout');
      return Promise.resolve(null);
    });
    await service.tick(); // error → consecutiveErrors = 1
    await service.tick(); // success → consecutiveErrors reset to 0

    expect(whatsAppAdapter.sendControlAlert).not.toHaveBeenCalled();
    expect(campaignService.setRunStatus).not.toHaveBeenCalled();
  });

  it('does NOT pause runs when errors are below the threshold (< 3)', async () => {
    const errorImpl = () => {
      campaignService.lastSendError = new Error('timeout');
      return Promise.resolve(null);
    };
    campaignService.processNextQueuedJob
      .mockImplementationOnce(errorImpl)
      .mockImplementationOnce(errorImpl);

    await service.tick(); // consecutiveErrors = 1
    await service.tick(); // consecutiveErrors = 2 (< 3)

    expect(campaignService.setRunStatus).not.toHaveBeenCalled();
    expect(whatsAppAdapter.sendControlAlert).not.toHaveBeenCalled();
  });

  it('pauses all runs after reaching the error threshold (3 consecutive errors)', async () => {
    const errorImpl = () => {
      campaignService.lastSendError = new Error('timeout');
      return Promise.resolve(null);
    };
    campaignService.processNextQueuedJob
      .mockImplementationOnce(errorImpl)
      .mockImplementationOnce(errorImpl)
      .mockImplementationOnce(errorImpl);

    await service.tick(); // 1
    await service.tick(); // 2
    await service.tick(); // 3 → pause

    expect(campaignService.setRunStatus).toHaveBeenCalledWith(RUN_ID, 'paused');
    expect(whatsAppAdapter.sendControlAlert).toHaveBeenCalledTimes(1);
  });

  it('pauses immediately on a disconnection error (first error, "session" keyword)', async () => {
    campaignService.processNextQueuedJob.mockImplementationOnce(() => {
      campaignService.lastSendError = new Error('session closed unexpectedly');
      return Promise.resolve(null);
    });

    await service.tick();

    expect(campaignService.setRunStatus).toHaveBeenCalledWith(RUN_ID, 'paused');
    expect(whatsAppAdapter.sendControlAlert).toHaveBeenCalledTimes(1);
  });

  it('pauses immediately on disconnection error with "destroyed" keyword', async () => {
    campaignService.processNextQueuedJob.mockImplementationOnce(() => {
      campaignService.lastSendError = new Error('target destroyed');
      return Promise.resolve(null);
    });

    await service.tick();

    expect(campaignService.setRunStatus).toHaveBeenCalledWith(RUN_ID, 'paused');
    expect(whatsAppAdapter.sendControlAlert).toHaveBeenCalledTimes(1);
  });

  it('pauses before calling processNextQueuedJob when adapter is disconnected', async () => {
    whatsAppAdapter.isConnected = false;

    await service.tick();

    expect(campaignService.processNextQueuedJob).not.toHaveBeenCalled();
    expect(campaignService.setRunStatus).toHaveBeenCalledWith(RUN_ID, 'paused');
    expect(whatsAppAdapter.sendControlAlert).toHaveBeenCalledTimes(1);
  });

  it('does NOT pause after 2 errors that follow a success (counter was reset)', async () => {
    campaignService.processNextQueuedJob
      .mockImplementationOnce(() => { campaignService.lastSendError = new Error('timeout'); return Promise.resolve(null); })
      .mockImplementationOnce(() => { campaignService.lastSendError = null; return Promise.resolve(null); })
      .mockImplementationOnce(() => { campaignService.lastSendError = new Error('timeout'); return Promise.resolve(null); })
      .mockImplementationOnce(() => { campaignService.lastSendError = new Error('timeout'); return Promise.resolve(null); });

    await service.tick(); // error #1 → consecutiveErrors = 1
    await service.tick(); // success → consecutiveErrors = 0
    await service.tick(); // error #1 again → consecutiveErrors = 1
    await service.tick(); // error #2 → consecutiveErrors = 2 (below threshold)

    expect(campaignService.setRunStatus).not.toHaveBeenCalled();
    expect(whatsAppAdapter.sendControlAlert).not.toHaveBeenCalled();
  });

  it('debounces repeated pause alerts within 1 minute', async () => {
    campaignService.processNextQueuedJob.mockImplementation(() => {
      campaignService.lastSendError = new Error('session destroyed');
      return Promise.resolve(null);
    });

    await service.tick(); // triggers pause + alert

    expect(whatsAppAdapter.sendControlAlert).toHaveBeenCalledTimes(1);
    whatsAppAdapter.sendControlAlert.mockClear();
    campaignService.setRunStatus.mockClear();

    // Second disconnection within 1 minute — debounce should suppress the alert
    await service.tick();

    expect(whatsAppAdapter.sendControlAlert).not.toHaveBeenCalled();
  });
});
