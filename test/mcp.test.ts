// End-to-end MCP test: drive the protocol via direct dispatch (the same
// code path the stdio server uses) and assert the JSON-RPC responses.

import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/db";
import { _setMemoryBackend } from "../src/memory";
import type { EmbeddingBackend } from "../src/embeddings";

class FakeBackend implements EmbeddingBackend {
  id = "fake";
  dim = 4;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    const lower = text.toLowerCase();
    if (lower.includes("api")) v[0] = 1;
    if (lower.includes("auth")) v[1] = 1;
    if (lower.includes("test")) v[2] = 1;
    if (lower.includes("deploy")) v[3] = 1;
    let n = 0;
    for (let i = 0; i < this.dim; i++) n += v[i]! * v[i]!;
    const norm = Math.sqrt(n);
    if (norm > 0) for (let i = 0; i < this.dim; i++) v[i]! /= norm;
    return v;
  }
}

// We invoke dispatch by feeding lines through the same code path as the
// stdio loop, but capture stdout instead of printing. Re-import after
// patching process.stdout.write.
async function rpc(method: string, params?: any, id: number | null = 1): Promise<any> {
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (s: string) => { captured.push(String(s)); return true; };
  try {
    // Lazy import to make sure the test-side stub on process.stdout is in
    // place before mcp.ts grabs a reference at module load.
    const mod = await import("../src/mcp");
    // @ts-expect-error reach into the module to drive dispatch directly
    const dispatch: (req: any) => Promise<void> = mod.__dispatch ?? null;
    if (!dispatch) {
      // Fallback: drive via stdout-capturing send by calling the server's
      // exported runner is wrong (it never exits). Instead we re-implement
      // the line by calling private dispatch: expose it for testing.
      throw new Error("mcp module does not export __dispatch for testing");
    }
    await dispatch({ jsonrpc: "2.0", id, method, params });
  } finally {
    (process.stdout.write as any) = orig;
  }
  const out = captured.join("");
  const lines = out.split("\n").filter((l) => l.trim().length > 0);
  return lines.length ? JSON.parse(lines[lines.length - 1]!) : null;
}

describe("mcp", () => {
  beforeEach(() => {
    db.run("DELETE FROM memory");
    _setMemoryBackend(new FakeBackend());
  });

  test("initialize returns protocol version and tool capability", async () => {
    const r = await rpc("initialize", {});
    expect(r.result.protocolVersion).toBe("2024-11-05");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe("anchor");
  });

  test("tools/list advertises remember, recall, list_memories, forget_memory", async () => {
    const r = await rpc("tools/list");
    const names = r.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["forget_memory", "list_memories", "recall", "remember"]);
  });

  test("tools/call remember then recall round-trips through the store", async () => {
    const saved = await rpc("tools/call", { name: "remember", arguments: { text: "rotated the auth keys", tags: ["security"] } });
    expect(saved.result.content[0].text).toContain("rotated the auth keys");

    const found = await rpc("tools/call", { name: "recall", arguments: { query: "auth rotation" } });
    expect(found.result.content[0].text).toContain("rotated the auth keys");
  });

  test("forget_memory removes by id", async () => {
    const saved = await rpc("tools/call", { name: "remember", arguments: { text: "test deploy notes" } });
    const idMatch = saved.result.content[0].text.match(/"id":\s*(\d+)/);
    const id = idMatch ? Number(idMatch[1]) : NaN;
    expect(Number.isFinite(id)).toBe(true);

    const removed = await rpc("tools/call", { name: "forget_memory", arguments: { id } });
    expect(removed.result.content[0].text).toContain("forgot #" + id);
  });

  test("unknown method returns -32601", async () => {
    const r = await rpc("nope/does/not/exist");
    expect(r.error.code).toBe(-32601);
  });

  test("notifications carry no id and produce no response", async () => {
    const r = await rpc("notifications/initialized", {}, null);
    expect(r).toBeNull();
  });
});
