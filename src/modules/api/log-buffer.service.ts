import { Injectable, LoggerService } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface LogEntry {
  ts: number;
  level: string;
  context: string;
  message: string;
}

@Injectable()
export class LogBufferService implements LoggerService {
  private readonly maxEntries = 300;
  private readonly buffer: LogEntry[] = [];
  readonly events$ = new Subject<LogEntry>();

  private push(level: string, message: unknown, context = '') {
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      context: String(context),
      message: typeof message === 'string' ? message : JSON.stringify(message),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxEntries) this.buffer.shift();
    this.events$.next(entry);
  }

  log(message: unknown, context?: string)   { this.push('LOG',   message, context); }
  error(message: unknown, context?: string) { this.push('ERROR', message, context); }
  warn(message: unknown, context?: string)  { this.push('WARN',  message, context); }
  debug(message: unknown, context?: string) { this.push('DEBUG', message, context); }
  verbose(message: unknown, context?: string) { this.push('VERBOSE', message, context); }

  getRecent(limit = 200): LogEntry[] {
    return this.buffer.slice(-limit);
  }
}
