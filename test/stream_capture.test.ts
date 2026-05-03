import { describe, expect, test } from "bun:test";
import { parseStreamUsage, replayStream, teeStream } from "../src/stream_capture";

describe("parseStreamUsage anthropic", () => {
  test("reads input_tokens from message_start and output_tokens from message_delta", () => {
    const sse = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"id":"x","usage":{"input_tokens":42,"cache_read_input_tokens":7,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":1}}}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}`,
      ``,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":99}}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join("\n");
    const t = parseStreamUsage(Buffer.from(sse, "utf8"), "anthropic");
    expect(t.input).toBe(42);
    expect(t.output).toBe(99);
    expect(t.cacheRead).toBe(7);
    expect(t.cacheWrite5m).toBe(3);
    expect(t.cacheWrite1h).toBe(1);
  });

  test("returns zeros when usage is absent", () => {
    const sse = `data: {"type":"ping"}\n\n`;
    const t = parseStreamUsage(Buffer.from(sse, "utf8"), "anthropic");
    expect(t.input).toBe(0);
    expect(t.output).toBe(0);
  });
});

describe("parseStreamUsage openai", () => {
  test("reads usage from final include_usage chunk", () => {
    const sse = [
      `data: {"choices":[{"delta":{"content":"hi"}}]}`,
      ``,
      `data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"prompt_tokens_details":{"cached_tokens":5}}}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join("\n");
    const t = parseStreamUsage(Buffer.from(sse, "utf8"), "openai");
    expect(t.input).toBe(12);
    expect(t.output).toBe(34);
    expect(t.cacheRead).toBe(5);
  });

  test("ignores malformed JSON lines", () => {
    const sse = `data: not json\n\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n`;
    const t = parseStreamUsage(Buffer.from(sse, "utf8"), "openai");
    expect(t.input).toBe(1);
    expect(t.output).toBe(2);
  });
});

describe("teeStream", () => {
  test("mirrors upstream bytes to client and resolves capture", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello "));
        c.enqueue(new TextEncoder().encode("world"));
        c.close();
      },
    });
    const { client, done } = teeStream(upstream);
    const reader = client.getReader();
    const out: Uint8Array[] = [];
    while (true) {
      const { value, done: end } = await reader.read();
      if (end) break;
      if (value) out.push(value);
    }
    const captured = await done;
    const clientText = Buffer.concat(out.map((u) => Buffer.from(u))).toString("utf8");
    expect(clientText).toBe("hello world");
    expect(captured.toString("utf8")).toBe("hello world");
  });
});

describe("replayStream", () => {
  test("emits the buffer in a single chunk", async () => {
    const buf = Buffer.from("event: ping\ndata: {}\n\n", "utf8");
    const reader = replayStream(buf).getReader();
    const out: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) out.push(value);
    }
    const text = Buffer.concat(out.map((u) => Buffer.from(u))).toString("utf8");
    expect(text).toBe(buf.toString("utf8"));
  });
});
