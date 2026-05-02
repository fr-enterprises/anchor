// Local SQLite store. One file at ~/.anchor/anchor.db.
// Holds the cache, spend events, and (later) memory entries.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".anchor");
const DB_PATH = join(DIR, "anchor.db");

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

export const db = new Database(DB_PATH);

const SCHEMA = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",

  `CREATE TABLE IF NOT EXISTS cache (
    key         TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    request     BLOB NOT NULL,
    response    BLOB NOT NULL,
    status      INTEGER NOT NULL,
    saved_at    INTEGER NOT NULL,
    hit_count   INTEGER NOT NULL DEFAULT 0,
    last_hit    INTEGER,
    miss_cost   REAL NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS cache_saved_at ON cache(saved_at)",
  // Migration: add miss_cost if upgrading from v0.0.x
  "ALTER TABLE cache ADD COLUMN miss_cost REAL NOT NULL DEFAULT 0",

  `CREATE TABLE IF NOT EXISTS spend (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    source      TEXT NOT NULL,
    input_tok   INTEGER NOT NULL DEFAULT 0,
    output_tok  INTEGER NOT NULL DEFAULT 0,
    cwrite5m    INTEGER NOT NULL DEFAULT 0,
    cwrite1h    INTEGER NOT NULL DEFAULT 0,
    cread       INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL NOT NULL,
    cache_hit   INTEGER NOT NULL DEFAULT 0,
    saved_usd   REAL NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS spend_ts ON spend(ts)",
  "ALTER TABLE spend ADD COLUMN saved_usd REAL NOT NULL DEFAULT 0",

  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

for (const sql of SCHEMA) {
  try { db.run(sql); } catch (e) {
    // ALTER TABLE on existing column is the only expected error here.
    const msg = (e as Error).message;
    if (!/duplicate column name/i.test(msg)) throw e;
  }
}

export const dbPath = DB_PATH;
