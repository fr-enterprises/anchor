// Stream capture and SSE usage parsing for streaming-aware cache.
//
// teeStream returns a ReadableStream that mirrors the upstream byte-for-byte
// to the client AND a Promise that resolves with the full captured payload
// once the upstream finishes. The capture is what we store in cache so that
// later requests can replay it.
//
// parseStreamUsage walks the captured SSE bytes and extracts input/output
// token counts. Anthropic emits a `message_start` event with input_tokens
// and a `message_delta` event with output_tokens. OpenAI emits usage in a
// final chunk only when the client opted in via stream_options.include_usage.
// When usage is missing we return zeros and the spend tracker stores a $0
// miss; the cache still works.

import type { Tokens } from "./pricing";

export function teeStream(upstream: ReadableStream<Uint8Array>): {
  client: ReadableStream<Uint8Array>;
  done: Promise<Buffer>;
} {
  const chunks: Uint8Array[] = [];
  let resolveDone!: (b: Buffer) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<Buffer>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const client = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done: end, value } = await reader.read();
          if (end) break;
          if (value) {
            chunks.push(value);
            controller.enqueue(value);
          }
        }
        controller.close();
        resolveDone(Buffer.concat(chunks.map((c) => Buffer.from(c))));
      } catch (e) {
        controller.error(e);
        rejectDone(e);
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    },
  });

  return { client, done };
}

// Walks SSE `data: {...}` lines and parses usage fields.
export function parseStreamUsage(buf: Buffer, provider: "anthropic" | "openai"): Tokens {
  const t: Tokens = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  const text = buf.toString("utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt: any;
    try { evt = JSON.parse(payload); } catch { continue; }

    if (provider === "anthropic") {
      // message_start carries input_tokens and any cache_creation/read counts.
      const u = evt?.message?.usage || evt?.usage;
      if (u) {
        if (u.input_tokens != null) t.input = Number(u.input_tokens) || t.input;
        if (u.output_tokens != null) t.output = Number(u.output_tokens) || t.output;
        if (u.cache_read_input_tokens != null) t.cacheRead = Number(u.cache_read_input_tokens) || t.cacheRead;
        const cc = u.cache_creation;
        if (cc?.ephemeral_5m_input_tokens != null) t.cacheWrite5m = Number(cc.ephemeral_5m_input_tokens) || t.cacheWrite5m;
        if (cc?.ephemeral_1h_input_tokens != null) t.cacheWrite1h = Number(cc.ephemeral_1h_input_tokens) || t.cacheWrite1h;
      }
    } else {
      const u = evt?.usage;
      if (u) {
        if (u.prompt_tokens != null) t.input = Number(u.prompt_tokens) || t.input;
        if (u.completion_tokens != null) t.output = Number(u.completion_tokens) || t.output;
        const cached = u.prompt_tokens_details?.cached_tokens;
        if (cached != null) t.cacheRead = Number(cached) || t.cacheRead;
      }
    }
  }
  return t;
}

// Replays a captured SSE byte buffer back to a client as a streaming
// response. We do not pace the chunks; the client receives them as fast as
// it can read. Real models pause between tokens, but for cache replay the
// fast path is the point.
export function replayStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      controller.close();
    },
  });
}
