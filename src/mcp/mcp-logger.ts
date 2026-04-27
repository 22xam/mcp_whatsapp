import * as fs from 'fs';
import * as path from 'path';

export interface McpLogger {
  log(message: string, details?: Record<string, unknown>): void;
}

export const PROJECT_ROOT = path.join(__dirname, '..', '..');
export const MCP_LOG_PATH = path.join(PROJECT_ROOT, 'logs', 'whatsapp-mcp-debug.log');

export class FileMcpLogger implements McpLogger {
  constructor(private readonly logPath = MCP_LOG_PATH) {}

  log(message: string, details?: Record<string, unknown>): void {
    const line = `[${new Date().toISOString()}] [MCP] ${message}${
      details ? ` ${JSON.stringify(details)}` : ''
    }\n`;

    try {
      process.stderr.write(line);
    } catch (err) {
      // Ignore EPIPE or other write errors to prevent server crash
    }

    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, line, 'utf-8');
    } catch {
      // If file logging fails, stderr still gives diagnostics without breaking MCP.
    }
  }
}

export function redactToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...args };
  if (typeof redacted.text === 'string') {
    redacted.text = `${redacted.text.slice(0, 80)}${redacted.text.length > 80 ? '...' : ''}`;
  }
  return redacted;
}
