import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

/**
 * Operational state only. Tasks live in Google Sheets — this database must
 * never become a shadow task manager. Everything here is either
 * (a) idempotency/dedup bookkeeping, (b) short-lived conversation state, or
 * (c) a cache that can be deleted without losing user data.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_events (
  dedupe_key   TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  day_key      TEXT,
  body_hash    TEXT,
  sent_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sent_messages_kind_day
  ON sent_messages(kind, day_key) WHERE day_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  current_task_id    TEXT,
  stuck_level        INTEGER NOT NULL DEFAULT 0,
  pending_micro_step TEXT,
  rescue_until       TEXT,
  math_question_id   TEXT,
  math_asked_at      TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket      TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS math_review_queue (
  question_id  TEXT PRIMARY KEY,
  concept      TEXT NOT NULL,
  given_answer TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
`;

export function openDb(filePath: string): Db {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare(
    `INSERT OR IGNORE INTO conversation_state (id, stuck_level, updated_at)
     VALUES (1, 0, datetime('now'))`,
  ).run();
  return db;
}

export function openMemoryDb(): Db {
  return openDb(':memory:');
}
