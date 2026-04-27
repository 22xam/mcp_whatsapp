import { runStartupSelector } from './startup-selector';

describe('runStartupSelector', () => {
  const originalEnv = process.env;
  const originalIsTty = process.stdin.isTTY;
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTty,
      configurable: true,
    });
    stdoutSpy.mockRestore();
  });

  it('skips the interactive selector in CI', async () => {
    process.env.CI = 'true';
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    await expect(runStartupSelector()).resolves.toBe('bot');
  });

  it('skips the interactive selector when explicitly disabled', async () => {
    process.env.BOT_OSCAR_SKIP_STARTUP_SELECTOR = '1';
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    await expect(runStartupSelector()).resolves.toBe('bot');
  });

  it('skips the interactive selector without a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    await expect(runStartupSelector()).resolves.toBe('bot');
  });
});
