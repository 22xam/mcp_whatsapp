import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database.Database;

  onModuleInit(): void {
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const defaultDbPath = join(dataDir, 'bugmate.sqlite');
    const dbPath = process.env['BOT_OSCAR_DB_PATH'] ?? defaultDbPath;
    const legacyDbPath = join(dataDir, 'bot-oscar.sqlite');
    if (dbPath === defaultDbPath && !existsSync(dbPath) && existsSync(legacyDbPath)) {
      copyFileSync(legacyDbPath, dbPath);
      this.logger.log('Copied legacy bot-oscar.sqlite database to bugmate.sqlite');
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.logger.log('Operational SQLite database initialized');
  }

  get connection(): Database.Database {
    if (!this.db) {
      this.onModuleInit();
    }
    return this.db;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        company TEXT NOT NULL DEFAULT '',
        systems_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        knowledge_docs_json TEXT NOT NULL DEFAULT '[]',
        trello_lists_json TEXT NOT NULL DEFAULT '{}',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opt_outs (
        phone TEXT PRIMARY KEY,
        reason TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaign_runs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        totals_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS campaign_jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        message TEXT NOT NULL,
        error TEXT,
        available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES campaign_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_campaign_jobs_run_status
        ON campaign_jobs(run_id, status);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        source TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_events_entity
        ON audit_events(entity_type, entity_id, created_at);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        summarized INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_messages_sender
        ON conversation_messages(sender_id, created_at);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        sender_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);

    this.addColumnIfMissing('campaign_jobs', 'available_at', 'TEXT');
    this.db
      .prepare("UPDATE campaign_jobs SET available_at = updated_at WHERE available_at IS NULL OR available_at = ''")
      .run();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_campaign_jobs_available
        ON campaign_jobs(status, available_at);
    `);
    this.addColumnIfMissing('clients', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
