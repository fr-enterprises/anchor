// Long-term memory store. Backed by the `memory` table in anchor's SQLite.
//
// The store holds text notes plus an embedding so that recall() can return
// the most relevant notes for a query. Embeddings reuse the same backend
// the cache uses (currently OpenAIEmbeddingBackend) so a single OPENAI_API_KEY
// drives both features. A future LocalFastEmbedBackend will let the store
// run with no network at all.
//
// This module is the storage layer. The MCP server in src/mcp.ts wraps it.

import { db } from "./db";
import { OpenAIEmbeddingBackend, cosine, type EmbeddingBackend } from "./embeddings";
import { vectorToBuffer, bufferToVector } from "./cache_serialize";

export interface MemoryEntry {
  id: number;
  text: string;
  tags: string[];
  source: string | null;
  createdAt: number;
}

export interface MemoryHit extends MemoryEntry {
  score: number;
}

let backend: EmbeddingBackend | null = null;
function getBackend(): EmbeddingBackend {
  if (backend) return backend;
  const openai = new OpenAIEmbeddingBackend();
  if (!openai.available()) {
    throw new Error("memory requires OPENAI_API_KEY (used only for embeddings, no other data leaves your machine)");
  }
  backend = openai;
  return backend;
}

// Test-only override so suite can swap in a deterministic backend.
export function _setMemoryBackend(b: EmbeddingBackend | null): void {
  backend = b;
}

const insertStmt = db.prepare(
  "INSERT INTO memory (text, tags, backend_id, vector, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
);
const allStmt = db.query("SELECT id, text, tags, source, created_at, backend_id, vector FROM memory WHERE backend_id = ? ORDER BY created_at DESC");
const listStmt = db.query("SELECT id, text, tags, source, created_at FROM memory ORDER BY created_at DESC LIMIT ?");
const deleteStmt = db.prepare("DELETE FROM memory WHERE id = ?");
const countStmt = db.query("SELECT COUNT(*) AS n FROM memory");

function rowToEntry(r: { id: number; text: string; tags: string; source: string | null; created_at: number }): MemoryEntry {
  let tags: string[] = [];
  try { const parsed = JSON.parse(r.tags); if (Array.isArray(parsed)) tags = parsed.map(String); } catch {}
  return { id: r.id, text: r.text, tags, source: r.source, createdAt: r.created_at };
}

export async function remember(opts: { text: string; tags?: string[]; source?: string }): Promise<MemoryEntry> {
  const text = opts.text.trim();
  if (!text) throw new Error("memory.remember: text is empty");
  const b = getBackend();
  const vector = await b.embed(text);
  const tags = JSON.stringify(opts.tags ?? []);
  const createdAt = Date.now();
  const result = insertStmt.run(text, tags, b.id, vectorToBuffer(vector), createdAt, opts.source ?? null);
  const id = Number(result.lastInsertRowid);
  return { id, text, tags: opts.tags ?? [], source: opts.source ?? null, createdAt };
}

export async function recall(opts: { query: string; k?: number; threshold?: number }): Promise<MemoryHit[]> {
  const query = opts.query.trim();
  if (!query) return [];
  const b = getBackend();
  const k = Math.max(1, Math.min(opts.k ?? 5, 50));
  const threshold = opts.threshold ?? 0;
  const queryVec = await b.embed(query);
  const rows = allStmt.all(b.id) as Array<{
    id: number; text: string; tags: string; source: string | null; created_at: number; backend_id: string; vector: Buffer;
  }>;
  const scored: MemoryHit[] = [];
  for (const r of rows) {
    const score = cosine(queryVec, bufferToVector(r.vector));
    if (score < threshold) continue;
    scored.push({ ...rowToEntry(r), score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function listRecent(limit = 20): MemoryEntry[] {
  const rows = listStmt.all(Math.max(1, Math.min(limit, 200))) as Array<{ id: number; text: string; tags: string; source: string | null; created_at: number }>;
  return rows.map(rowToEntry);
}

export function forget(id: number): boolean {
  const result = deleteStmt.run(id);
  return result.changes > 0;
}

export function memoryCount(): number {
  return (countStmt.get() as { n: number }).n;
}
