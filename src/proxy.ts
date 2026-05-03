// HTTP proxy. Listens on localhost. Intercepts Anthropic and OpenAI API
// calls, applies the exact-match cache, forwards on miss, records spend.
//
// Streaming requests bypass the cache (v0.2 will add streaming-aware cache).
//
// Upstream URLs:
//   ANTHROPIC_UPSTREAM (default https://api.anthropic.com)
//   OPENAI_UPSTREAM    (default https://api.openai.com)
//
// Trick: if you already have a CF Worker proxy for one of these, point
// the upstream env at the worker URL.

import { keyOf, store, tryHit, cacheStats } from "./cache";
import { recordEvent } from "./spend";
import { costUsd, type Tokens } from "./pricing";
import { OpenAIEmbeddingBackend, type EmbeddingBackend } from "./embeddings";
import { storeEmbedding, bestSemanticMatch } from "./embedding_store";
import { inputTextFor } from "./cache_serialize";
import { teeStream, parseStreamUsage, replayStream } from "./stream_capture";
import { db } from "./db";

const ANTHROPIC_UPSTREAM = process.env.ANTHROPIC_UPSTREAM || "https://api.anthropic.com";
const OPENAI_UPSTREAM = process.env.OPENAI_UPSTREAM || "https://api.openai.com";

// Semantic indexing toggle. When enabled, every cache MISS computes an
// embedding of the request's input text and stores it for later fuzzy
// lookup. Off by default in v0.2.0 so behaviour matches v0.1; flip to
// ANCHOR_SEMANTIC=1 to opt in. The lookup path is added in a follow-up PR.
const SEMANTIC_ENABLED = process.env.ANCHOR_SEMANTIC === "1";

// Cosine similarity threshold for the semantic lookup on cache miss. A high
// default keeps false-positive rate low: only near-duplicate prompts return a
// cached response. Override with ANCHOR_SEMANTIC_THRESHOLD if you want to
// trade recall for precision.
const SEMANTIC_THRESHOLD = (() => {
  const v = parseFloat(process.env.ANCHOR_SEMANTIC_THRESHOLD || "");
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.95;
})();

const lookupByKey = db.query(
  "SELECT response, status, miss_cost, model, provider FROM cache WHERE key = ?",
);

function detectProvider(url: URL): "anthropic" | "openai" | null {
  if (url.pathname.startsWith("/v1/messages")) return "anthropic";
  if (url.pathname.startsWith("/v1/chat/completions")) return "openai";
  if (url.pathname.startsWith("/v1/completions")) return "openai";
  return null;
}

function upstreamFor(provider: "anthropic" | "openai"): string {
  return provider === "anthropic" ? ANTHROPIC_UPSTREAM : OPENAI_UPSTREAM;
}

function tokensFromAnthropic(usage: any): Tokens {
  if (!usage) return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  const cc = usage.cache_creation || {};
  return {
    input: Number(usage.input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    cacheWrite5m: Number(cc.ephemeral_5m_input_tokens) || 0,
    cacheWrite1h: Number(cc.ephemeral_1h_input_tokens) || 0,
    cacheRead: Number(usage.cache_read_input_tokens) || 0,
  };
}

function tokensFromOpenAI(usage: any): Tokens {
  if (!usage) return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  return {
    input: Number(usage.prompt_tokens) || 0,
    output: Number(usage.completion_tokens) || 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
  };
}

function modelFromBody(body: any): string {
  return body?.model || "unknown";
}

function sourceFromHeaders(req: Request): string {
  return (
    req.headers.get("x-anchor-source") ||
    req.headers.get("user-agent")?.split(/[\s/]/)[0] ||
    "unknown"
  );
}

async function passThrough(req: Request, target: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  const init: RequestInit = {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    // @ts-ignore Bun supports duplex
    duplex: "half",
  };
  return fetch(target, init);
}

export function start(opts: { port: number; host: string; verbose?: boolean }) {
  const log = (...args: any[]) => {
    if (opts.verbose) console.log("[anchor]", ...args);
  };

  // Lazily initialise an embedding backend if semantic indexing is enabled.
  // We skip initialisation entirely when SEMANTIC_ENABLED is false so users
  // who do not want any embedding-related side effects pay zero overhead.
  let embeddings: EmbeddingBackend | null = null;
  if (SEMANTIC_ENABLED) {
    const openai = new OpenAIEmbeddingBackend();
    if (openai.available()) {
      embeddings = openai;
      log("semantic indexing ON, backend=" + openai.id);
    } else {
      log("ANCHOR_SEMANTIC=1 set but OPENAI_API_KEY missing; semantic indexing disabled");
    }
  }

  async function indexMiss(cacheKey: string, body: any): Promise<void> {
    if (!embeddings) return;
    const text = inputTextFor(body);
    if (!text) return;
    try {
      const vector = await embeddings.embed(text);
      storeEmbedding({ cacheKey, backendId: embeddings.id, text, vector });
    } catch (e) {
      log("embedding failed", (e as Error).message);
    }
  }

  // Semantic lookup on miss: embed the request's input text, scan stored
  // embeddings for the closest match above SEMANTIC_THRESHOLD, and only
  // accept it if the stored row was produced for the same provider+model.
  // Cross-model reuse would mix output styles and is almost always wrong.
  async function trySemanticHit(
    body: any,
    provider: "anthropic" | "openai",
    model: string,
  ): Promise<{ status: number; body: Buffer; missCost: number; score: number } | null> {
    if (!embeddings) return null;
    const text = inputTextFor(body);
    if (!text) return null;
    let vector: Float32Array;
    try {
      vector = await embeddings.embed(text);
    } catch (e) {
      log("semantic embed failed", (e as Error).message);
      return null;
    }
    const match = bestSemanticMatch({
      query: vector,
      backendId: embeddings.id,
      threshold: SEMANTIC_THRESHOLD,
    });
    if (!match) return null;
    const row = lookupByKey.get(match.cacheKey) as
      | { response: Buffer; status: number; miss_cost: number; model: string; provider: string }
      | undefined;
    if (!row) return null;
    if (row.provider !== provider || row.model !== model) return null;
    return { status: row.status, body: row.response, missCost: row.miss_cost ?? 0, score: match.score };
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/__anchor/health") {
        return new Response(JSON.stringify({ ok: true, ...cacheStats() }), {
          headers: { "content-type": "application/json" },
        });
      }

      const provider = detectProvider(url);
      if (!provider) {
        // Unknown path: passthrough to upstream that matches host header guess.
        return new Response("anchor: unknown path " + url.pathname, { status: 404 });
      }

      const upstream = upstreamFor(provider) + url.pathname + url.search;
      const source = sourceFromHeaders(req);

      // Read body so we can hash it. For non-POST, just pass through.
      if (req.method !== "POST") return passThrough(req, upstream);

      const reqBuf = Buffer.from(await req.arrayBuffer());
      let body: any = {};
      try { body = JSON.parse(reqBuf.toString("utf8")); } catch {}

      const isStream = !!body.stream;
      const model = modelFromBody(body);

      // Cache lookup. The key includes the stream flag, so streaming and
      // non-streaming variants of the same prompt are stored independently
      // and we always serve them back in the format the client expected.
      const k = keyOf({ provider, model, body });
      const hit = tryHit(k);
      if (hit) {
        // For non-stream entries, the body is JSON; usage is in the JSON.
        // For stream entries, the body is raw SSE bytes; usage was parsed
        // at miss time and we do not re-derive it on hit (would require
        // re-walking the SSE on every hit). Spend gets cacheHit=true with
        // tokens reported on the original miss; we keep tokens=zero on
        // stream hits so we don't double-count phantom tokens.
        let tokens: Tokens = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
        if (!hit.isStream) {
          let usage: any = {};
          try { usage = JSON.parse(hit.body.toString("utf8"))?.usage || {}; } catch {}
          tokens = provider === "anthropic" ? tokensFromAnthropic(usage) : tokensFromOpenAI(usage);
        }
        recordEvent({ provider, model, source, tokens, cacheHit: true, savedUsd: hit.missCost });
        log(hit.isStream ? "HIT-STREAM" : "HIT", provider, model, source, "saved $" + hit.missCost.toFixed(6));
        if (hit.isStream) {
          return new Response(replayStream(hit.body), {
            status: hit.status,
            headers: { "content-type": "text/event-stream", "x-anchor-cache": "hit" },
          });
        }
        return new Response(hit.body, {
          status: hit.status,
          headers: { "content-type": "application/json", "x-anchor-cache": "hit" },
        });
      }

      // Exact-match missed. Try a semantic lookup before paying for an
      // upstream call. Only runs for non-streaming requests in this version;
      // semantic replay over SSE is a future PR.
      if (!isStream && embeddings) {
        const sem = await trySemanticHit(body, provider, model);
        if (sem) {
          let usage: any = {};
          try { usage = JSON.parse(sem.body.toString("utf8"))?.usage || {}; } catch {}
          const tokens = provider === "anthropic" ? tokensFromAnthropic(usage) : tokensFromOpenAI(usage);
          recordEvent({ provider, model, source, tokens, cacheHit: true, savedUsd: sem.missCost });
          log("HIT-SEM", provider, model, source, "score=" + sem.score.toFixed(4), "saved $" + sem.missCost.toFixed(6));
          return new Response(sem.body, {
            status: sem.status,
            headers: {
              "content-type": "application/json",
              "x-anchor-cache": "semantic",
              "x-anchor-semantic-score": sem.score.toFixed(4),
            },
          });
        }
      }

      // Forward.
      const forwardHeaders = new Headers(req.headers);
      forwardHeaders.delete("host");
      forwardHeaders.delete("content-length");
      const upstreamResp = await fetch(upstream, {
        method: "POST",
        headers: forwardHeaders,
        body: reqBuf,
      });

      // Streaming: tee the upstream body so the client gets a normal SSE
      // stream while we collect the bytes for the cache. Storage happens
      // after the upstream finishes; the client does not wait on it.
      if (isStream) {
        if (!upstreamResp.body || !upstreamResp.ok) {
          log("ERR-STREAM", provider, model, source, upstreamResp.status);
          return new Response(upstreamResp.body, {
            status: upstreamResp.status,
            headers: upstreamResp.headers,
          });
        }
        const { client, done } = teeStream(upstreamResp.body);
        done.then((buf) => {
          const tokens = parseStreamUsage(buf, provider);
          const missCost = costUsd(tokens, model);
          recordEvent({ provider, model, source, tokens, cacheHit: false, savedUsd: 0 });
          log("MISS-STREAM", provider, model, source, "$" + missCost.toFixed(6));
          store({
            key: k,
            provider,
            model,
            request: reqBuf,
            response: buf,
            status: upstreamResp.status,
            missCost,
            isStream: true,
          });
          if (embeddings) indexMiss(k, body);
        }).catch((e) => log("stream capture failed", (e as Error).message));

        // Forward upstream headers so content-type, anthropic-organization,
        // etc. flow through unchanged.
        return new Response(client, {
          status: upstreamResp.status,
          headers: upstreamResp.headers,
        });
      }

      const respBuf = Buffer.from(await upstreamResp.arrayBuffer());

      // Record spend on miss.
      if (upstreamResp.ok) {
        let usage: any = {};
        try { usage = JSON.parse(respBuf.toString("utf8"))?.usage || {}; } catch {}
        const tokens = provider === "anthropic" ? tokensFromAnthropic(usage) : tokensFromOpenAI(usage);
        const missCost = costUsd(tokens, model);
        recordEvent({ provider, model, source, tokens, cacheHit: false, savedUsd: 0 });
        log("MISS", provider, model, source, "$" + missCost.toFixed(6));

        // Store in cache with the cost of this miss so future hits can
        // accurately report savings.
        store({
          key: k,
          provider,
          model,
          request: reqBuf,
          response: respBuf,
          status: upstreamResp.status,
          missCost,
        });

        // If semantic indexing is enabled, embed the input text and store
        // it alongside the cache entry. We do this fire-and-forget so the
        // user-facing response is not delayed by the embedding round-trip.
        indexMiss(k, body);
      } else {
        log("ERR ", provider, model, source, upstreamResp.status);
      }

      return new Response(respBuf, {
        status: upstreamResp.status,
        headers: upstreamResp.headers,
      });
    },
  });

  return server;
}
