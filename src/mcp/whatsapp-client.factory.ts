import { Client, LocalAuth } from 'whatsapp-web.js';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { McpLogger } from './mcp-logger.js';

export interface WhatsAppClientFactory {
  create(): Client;
  cleanupBrowserProcesses?(): Promise<number>;
}

const execFileAsync = promisify(execFile);

function loadEnv(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    result[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return result;
}

export class LocalAuthWhatsAppClientFactory implements WhatsAppClientFactory {
  constructor(private readonly logger: McpLogger) {}

  create(): Client {
    const { sessionId, dataPath } = this.getSessionConfig();
    const chromePath =
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

    this.logger.log('Creating WhatsApp client', {
      cwd: process.cwd(),
      sessionId,
      dataPath,
      dataPathExists: fs.existsSync(dataPath),
      chromePath,
      chromeExists: fs.existsSync(chromePath),
    });

    return new Client({
      authStrategy: new LocalAuth({
        dataPath,
        clientId: sessionId,
      }),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });
  }

  async cleanupBrowserProcesses(): Promise<number> {
    const sessionPath = this.getSessionProfilePath();
    const enabled = this.getCleanupEnabled();

    if (!enabled) {
      this.logger.log(
        'Skipping browser cleanup because WHATSAPP_CLEANUP_ORPHANED_BROWSERS is disabled',
        {
          sessionPath,
        },
      );
      return 0;
    }

    this.logger.log('Cleaning browser processes for WhatsApp session', {
      sessionPath,
    });

    if (process.platform === 'win32') {
      return this.cleanupWindowsBrowserProcesses(sessionPath);
    }

    this.logger.log('Browser process cleanup is only implemented on Windows', {
      platform: process.platform,
      sessionPath,
    });
    return 0;
  }

  private getSessionConfig(): { sessionId: string; dataPath: string } {
    const env = loadEnv();
    const sessionId =
      process.env['WHATSAPP_SESSION_ID'] ?? env['WHATSAPP_SESSION_ID'] ?? 'mcp';
    const dataPath =
      process.env['WHATSAPP_DATA_PATH'] ??
      env['WHATSAPP_DATA_PATH'] ??
      path.join(__dirname, '..', '..', '.wwebjs_auth');

    return {
      sessionId,
      dataPath,
    };
  }

  private getSessionProfilePath(): string {
    const { dataPath, sessionId } = this.getSessionConfig();
    return path.resolve(dataPath, `session-${sessionId}`);
  }

  private getCleanupEnabled(): boolean {
    const env = loadEnv();
    const value =
      process.env['WHATSAPP_CLEANUP_ORPHANED_BROWSERS'] ??
      env['WHATSAPP_CLEANUP_ORPHANED_BROWSERS'] ??
      'true';

    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }

  private async cleanupWindowsBrowserProcesses(
    sessionPath: string,
  ): Promise<number> {
    const escapedSessionPath = sessionPath.replace(/'/g, "''");
    const script = `
$sessionPath = '${escapedSessionPath}'
$escapedLike = [WildcardPattern]::Escape($sessionPath)
$processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like "*$escapedLike*" -and
    $_.Name -match '^(chrome|msedge|chromium|chrome-headless-shell)\\.exe$'
  }

$count = 0
foreach ($process in $processes) {
  try {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    $count += 1
  } catch {
    # The process may have already exited after CIM listed it.
  }
}

Write-Output $count
`;

    try {
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          script,
        ],
        { windowsHide: true },
      );
      const killedCount =
        Number.parseInt(stdout.trim().split(/\r?\n/).at(-1) ?? '0', 10) || 0;

      this.logger.log('Browser process cleanup finished', {
        sessionPath,
        killedCount,
        stderr: stderr.trim() || undefined,
      });

      return killedCount;
    } catch (error) {
      this.logger.log('Browser process cleanup failed', {
        sessionPath,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      return 0;
    }
  }
}
