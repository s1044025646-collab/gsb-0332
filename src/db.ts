import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const DATA_DIR = process.env.GRAY_DATA_DIR ?? path.join(process.cwd(), "data");
export const DB_PATH = process.env.GRAY_DB_PATH ?? path.join(DATA_DIR, "graycode.db");

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      width INTEGER NOT NULL,
      bit_order TEXT NOT NULL DEFAULT 'msb-first',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS samples (
      rule_id INTEGER NOT NULL REFERENCES rules(id),
      seq INTEGER NOT NULL,
      code TEXT NOT NULL,
      position TEXT NOT NULL,
      batch_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (rule_id, seq)
    );
    CREATE TABLE IF NOT EXISTS transitions (
      rule_id INTEGER NOT NULL REFERENCES rules(id),
      seq INTEGER NOT NULL,
      from_code TEXT NOT NULL,
      to_code TEXT NOT NULL,
      hamming INTEGER NOT NULL,
      changed_bits TEXT NOT NULL,
      delta TEXT NOT NULL,
      kind TEXT NOT NULL,
      direction TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (rule_id, seq)
    );
    CREATE TABLE IF NOT EXISTS state (
      rule_id INTEGER PRIMARY KEY REFERENCES rules(id),
      last_seq INTEGER NOT NULL,
      last_code TEXT NOT NULL,
      last_position TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS batches (
      rule_id INTEGER NOT NULL REFERENCES rules(id),
      idempotency_key TEXT NOT NULL,
      from_seq INTEGER NOT NULL,
      to_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (rule_id, idempotency_key)
    );
  `);
  return db;
}
