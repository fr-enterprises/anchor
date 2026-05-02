// Persistence + lookup helpers for cache_embeddings. Sits next to the cache
// table and joins by cache_key. Semantic lookup is added in a follow-up PR;
// this file is the first half — write side only.

import { db } from "./db";
import { vectorToBuffer, bufferToVector } from "./cache_serialize";
import { cosine } from "./embeddings";

const insert = db.prepare(
  "INSERT OR REPLACE INTO cache_embeddings (cache_key, backend_id, text, vector, saved_at) VALUES (?, ?, ?, ?, ?)",
);

export function storeEmbedding(opts: {
  cacheKey: string;
  backendId: string;
  text: string;
  vector: Float32Array;
}) {
  insert.run(
    opts.cacheKey,
    opts.backendId,
    opts.text,
    vectorToBuffer(opts.vector),
    Date.now(),
  );
}

// candidates() returns every (cache_key, vector) pair stored under the
// given backend_id. The lookup PR will iterate this and score by cosine.
// For larger registries we'd add an HNSW index sidecar; for the typical
// thousand-or-two cache size on a dev box, scanning is fine.
export function* candidates(backendId: string): Generator<{ cacheKey: string; vector: Float32Array }> {
  const stmt = db.query("SELECT cache_key, vector FROM cache_embeddings WHERE backend_id = ?");
  const rows = stmt.all(backendId) as Array<{ cache_key: string; vector: Buffer }>;
  for (const r of rows) {
    yield { cacheKey: r.cache_key, vector: bufferToVector(r.vector) };
  }
}

export function bestSemanticMatch(opts: {
  query: Float32Array;
  backendId: string;
  threshold: number;
}): { cacheKey: string; score: number } | null {
  let best: { cacheKey: string; score: number } | null = null;
  for (const c of candidates(opts.backendId)) {
    const score = cosine(opts.query, c.vector);
    if (score < opts.threshold) continue;
    if (!best || score > best.score) best = { cacheKey: c.cacheKey, score };
  }
  return best;
}

export function embeddingCount(backendId?: string): number {
  if (backendId) {
    return (db.query("SELECT COUNT(*) AS n FROM cache_embeddings WHERE backend_id = ?").get(backendId) as { n: number }).n;
  }
  return (db.query("SELECT COUNT(*) AS n FROM cache_embeddings").get() as { n: number }).n;
}
