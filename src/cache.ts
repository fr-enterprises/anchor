// Exact-match cache. Hash key over model + system + messages + max_tokens
// + temperature so identical requests return the same cached body. Streaming
// requests bypass the cache (we do not store SSE chunks yet; v0.2).

import { createHash } from "node:crypto";
import { db } from "./db";

export interface CacheKey {
  provider: string;
  model: string;
  body: any;
}

export function keyOf({ provider, model, body }: CacheKey): string {
  const norm = {
    provider,
    model,
    system: body.system ?? null,
    messages: body.messages ?? null,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null,
    temperature: body.temperature ?? null,
    tools: body.tools ?? null,
    response_format: body.response_format ?? null,
    // Streaming and non-streaming get separate cache entries: the stored
    // payload differs (SSE bytes vs JSON), and replay paths diverge.
    stream: !!body.stream,
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

const insert = db.prepare(
  "INSERT OR REPLACE INTO cache (key, provider, model, request, response, status, saved_at, miss_cost, is_stream) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const lookup = db.prepare(
  "SELECT response, status, miss_cost, is_stream FROM cache WHERE key = ?",
);
const bumpHit = db.prepare(
  "UPDATE cache SET hit_count = hit_count + 1, last_hit = ? WHERE key = ?",
);
const sizeQ = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(response)),0) AS bytes FROM cache");
const purge = db.prepare("DELETE FROM cache");

export function tryHit(key: string): { status: number; body: Buffer; missCost: number; isStream: boolean } | null {
  const row = lookup.get(key) as { response: Buffer; status: number; miss_cost: number; is_stream: number } | undefined;
  if (!row) return null;
  bumpHit.run(Date.now(), key);
  return {
    status: row.status,
    body: row.response,
    missCost: row.miss_cost ?? 0,
    isStream: !!row.is_stream,
  };
}

export function store(opts: {
  key: string;
  provider: string;
  model: string;
  request: Buffer;
  response: Buffer;
  status: number;
  missCost: number;
  isStream?: boolean;
}) {
  insert.run(
    opts.key,
    opts.provider,
    opts.model,
    opts.request,
    opts.response,
    opts.status,
    Date.now(),
    opts.missCost,
    opts.isStream ? 1 : 0,
  );
}

export function cacheStats(): { entries: number; bytes: number } {
  const row = sizeQ.get() as { n: number; bytes: number };
  return { entries: row.n, bytes: row.bytes };
}

export function clearCache(): number {
  const stats = cacheStats();
  purge.run();
  return stats.entries;
}
