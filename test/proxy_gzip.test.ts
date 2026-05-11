import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { gzipSync } from "node:zlib";

// Regression: ZlibError on the client when anchor forwarded the upstream's
// `content-encoding: gzip` header alongside an already-decompressed body.

let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let proxyPort = 0;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    fetch() {
      const json = JSON.stringify({
        id: "msg_x", type: "message", role: "assistant", model: "claude",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return new Response(gzipSync(Buffer.from(json)), {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    },
  });
  process.env.ANTHROPIC_UPSTREAM = `http://127.0.0.1:${upstream.port}`;
  // Dynamic import AFTER env is set, so the module-level constant picks it up.
  const { start } = await import("../src/proxy");
  proxy = start({ port: 0, host: "127.0.0.1" });
  proxyPort = proxy.port;
});

afterAll(() => { proxy.stop(true); upstream.stop(true); });

describe("proxy compression handling", () => {
  test("strips upstream content-encoding so client doesn't try to decompress decoded body", async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test" },
      body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBeNull();
    const json: any = await r.json();
    expect(json.content[0].text).toBe("hi");
  });
});
