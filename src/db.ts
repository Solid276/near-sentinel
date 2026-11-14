import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Subscription {
  telegram_id: string;
  account_id: string;
  warn_pct: number;
  crit_pct: number;
  last_alert_level: string | null;
  last_alert_at: number | null;
  last_hf: number | null;
  last_poll_at: number | null;
}

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
      telegram_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      warn_pct REAL NOT NULL DEFAULT 125,
      crit_pct REAL NOT NULL DEFAULT 110,
      last_alert_level TEXT,
      last_alert_at INTEGER,
      last_hf REAL,
      last_poll_at INTEGER
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
      telegram_id TEXT PRIMARY KEY,
      last_request_at INTEGER NOT NULL
    )`);
  }
  get(id: string): Subscription | undefined {
    return this.db.prepare('SELECT * FROM subscriptions WHERE telegram_id=?').get(id) as unknown as Subscription | undefined;
  }
  all(): Subscription[] { return this.db.prepare('SELECT * FROM subscriptions').all() as unknown as Subscription[]; }
  upsert(id: string, account: string): void {
    this.db.prepare(`INSERT INTO subscriptions(telegram_id,account_id) VALUES(?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET account_id=excluded.account_id,
      last_alert_level=NULL,last_alert_at=NULL,last_hf=NULL,last_poll_at=NULL`).run(id, account);
  }
  updateThresholds(id: string, warn: number, crit: number): void {
    this.db.prepare('UPDATE subscriptions SET warn_pct=?,crit_pct=? WHERE telegram_id=?').run(warn, crit, id);
  }
  updatePoll(id: string, hf: number | null, at: number): void {
    this.db.prepare('UPDATE subscriptions SET last_hf=?,last_poll_at=? WHERE telegram_id=?').run(hf, at, id);
  }
  updateAlert(id: string, level: string | null, at: number | null): void {
    this.db.prepare('UPDATE subscriptions SET last_alert_level=?,last_alert_at=? WHERE telegram_id=?').run(level, at, id);
  }
  remove(id: string): void { this.db.prepare('DELETE FROM subscriptions WHERE telegram_id=?').run(id); }
  allowRequest(id: string, intervalSeconds: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare('SELECT last_request_at FROM rate_limits WHERE telegram_id=?').get(id) as {last_request_at:number} | undefined;
    if (row && now - row.last_request_at < intervalSeconds) return false;
    this.db.prepare(`INSERT INTO rate_limits(telegram_id,last_request_at) VALUES(?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET last_request_at=excluded.last_request_at`).run(id, now);
    return true;
  }
}
