// Records spend events from every upstream call. Cache hits record
// $0 cost and a savings number (what the call would have cost).

import { db } from "./db";
import { costUsd, type Tokens } from "./pricing";

export interface SpendEntry {
  ts: number;
  provider: string;
  model: string;
  source: string;
  tokens: Tokens;
  costUsd: number;
  cacheHit: boolean;
}

const insert = db.prepare(
  `INSERT INTO spend (ts, provider, model, source, input_tok, output_tok, cwrite5m, cwrite1h, cread, cost_usd, cache_hit, saved_usd)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function recordEvent(opts: {
  provider: string;
  model: string;
  source: string;
  tokens: Tokens;
  cacheHit: boolean;
  savedUsd: number;
}): SpendEntry {
  const cost = opts.cacheHit ? 0 : costUsd(opts.tokens, opts.model);
  insert.run(
    Date.now(),
    opts.provider,
    opts.model,
    opts.source,
    opts.tokens.input,
    opts.tokens.output,
    opts.tokens.cacheWrite5m,
    opts.tokens.cacheWrite1h,
    opts.tokens.cacheRead,
    cost,
    opts.cacheHit ? 1 : 0,
    opts.savedUsd,
  );
  return {
    ts: Date.now(),
    provider: opts.provider,
    model: opts.model,
    source: opts.source,
    tokens: opts.tokens,
    costUsd: cost,
    cacheHit: opts.cacheHit,
  };
}

export interface SummaryRow {
  bucket: string;
  hits: number;
  misses: number;
  costUsd: number;
  savedUsd: number;
  inputTok: number;
  outputTok: number;
}

function bucketSql(by: "day" | "model" | "source"): string {
  if (by === "day")    return "strftime('%Y-%m-%d', ts/1000, 'unixepoch')";
  if (by === "model")  return "model";
  return "source";
}

export function summary(opts: { sinceTs: number; by: "day" | "model" | "source" }): SummaryRow[] {
  const bucket = bucketSql(opts.by);
  const stmt = db.query(
    `SELECT ${bucket} AS bucket,
            SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS hits,
            SUM(CASE WHEN cache_hit = 0 THEN 1 ELSE 0 END) AS misses,
            SUM(cost_usd) AS cost_usd,
            SUM(input_tok) AS input_tok,
            SUM(output_tok) AS output_tok
       FROM spend
      WHERE ts >= ?
      GROUP BY bucket
      ORDER BY bucket DESC`,
  );
  const rows = stmt.all(opts.sinceTs) as Array<{
    bucket: string;
    hits: number;
    misses: number;
    cost_usd: number;
    input_tok: number;
    output_tok: number;
  }>;

  const savingsStmt = db.query(
    `SELECT ${bucket} AS bucket,
            SUM(saved_usd) AS saved
       FROM spend
      WHERE ts >= ? AND cache_hit = 1
      GROUP BY bucket`,
  );

  const savedMap = new Map<string, number>();
  const savedRows = savingsStmt.all(opts.sinceTs) as Array<{ bucket: string; saved: number }>;
  for (const r of savedRows) savedMap.set(r.bucket, r.saved);

  return rows.map((r) => ({
    bucket: r.bucket,
    hits: r.hits,
    misses: r.misses,
    costUsd: r.cost_usd ?? 0,
    savedUsd: savedMap.get(r.bucket) ?? 0,
    inputTok: r.input_tok ?? 0,
    outputTok: r.output_tok ?? 0,
  }));
}

export function totals(opts: { sinceTs: number }): {
  spent: number; saved: number; hits: number; misses: number;
} {
  const r = db.query(
    `SELECT SUM(cost_usd) AS spent,
            SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS hits,
            SUM(CASE WHEN cache_hit = 0 THEN 1 ELSE 0 END) AS misses
       FROM spend WHERE ts >= ?`,
  ).get(opts.sinceTs) as { spent: number; hits: number; misses: number };

  const savedRow = db.query(
    `SELECT SUM(saved_usd) AS saved FROM spend WHERE ts >= ? AND cache_hit = 1`,
  ).get(opts.sinceTs) as { saved: number };

  return {
    spent: r.spent ?? 0,
    saved: savedRow.saved ?? 0,
    hits: r.hits ?? 0,
    misses: r.misses ?? 0,
  };
}
