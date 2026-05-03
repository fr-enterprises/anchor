// Local SQLite store. One file at ~/.anchor/anchor.db.
// Holds the cache, spend events, and (later) memory entries.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ANCHOR_DB overrides the default path. Tests pass `:memory:` so they do
// not touch the user's real cache. Anything else is treated as a file path.
const OVERRIDE = process.env.ANCHOR_DB;
const DIR = join(homedir(), ".anchor");
const DB_PATH = OVERRIDE && OVERRIDE !== ":memory:" ? OVERRIDE : join(DIR, "anchor.db");

if (!OVERRIDE && !existsSync(DIR)) mkdirSync(DIR, { recursive: true });

export const db = new Database(OVERRIDE === ":memory:" ? ":memory:" : DB_PATH);

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
  // v0.3: streaming-aware cache. is_stream marks rows where `response` is a
  // raw SSE byte stream that must be replayed chunk-by-chunk rather than
  // returned as a single JSON body.
  "ALTER TABLE cache ADD COLUMN is_stream INTEGER NOT NULL DEFAULT 0",

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

  // v0.2: semantic-fuzzy cache index. Holds the input text used to derive
  // each cache entry and a pointer into the embeddings store. The actual
  // float32 vector sits in a sibling BLOB so SQLite query planning stays
  // sane on the cache table.
  `CREATE TABLE IF NOT EXISTS cache_embeddings (
    cache_key   TEXT PRIMARY KEY REFERENCES cache(key) ON DELETE CASCADE,
    backend_id  TEXT NOT NULL,
    text        TEXT NOT NULL,
    vector      BLOB NOT NULL,
    saved_at    INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS cache_embeddings_backend ON cache_embeddings(backend_id)",

  // v0.4: long-term memory store. Independent from the cache. The MCP
  // server (anchor mcp) exposes recall/remember tools backed by this table
  // so Claude Code and Cursor can persist notes across sessions.
  `CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    backend_id  TEXT NOT NULL,
    vector      BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    source      TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS memory_created_at ON memory(created_at)",
  "CREATE INDEX IF NOT EXISTS memory_backend ON memory(backend_id)",
];

for (const sql of SCHEMA) {
  try { db.run(sql); } catch (e) {
    // ALTER TABLE on existing column is the only expected error here.
    const msg = (e as Error).message;
    if (!/duplicate column name/i.test(msg)) throw e;
  }
}

export const dbPath = DB_PATH;
