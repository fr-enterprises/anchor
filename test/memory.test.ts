import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/db";
import { remember, recall, listRecent, forget, memoryCount, _setMemoryBackend } from "../src/memory";
import type { EmbeddingBackend } from "../src/embeddings";

// A fake embedding backend that turns text into a deterministic vector based
// on simple word presence. Lets us test recall ranking without hitting the
// network or shipping an ONNX model.
class FakeBackend implements EmbeddingBackend {
  id = "fake";
  dim = 8;
  private vocab = ["red", "blue", "fish", "bird", "fast", "slow", "money", "time"];
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    const lower = text.toLowerCase();
    let n = 0;
    for (let i = 0; i < this.vocab.length; i++) {
      if (lower.includes(this.vocab[i]!)) {
        v[i] = 1;
        n += 1;
      }
    }
    const norm = Math.sqrt(n);
    if (norm > 0) for (let i = 0; i < this.dim; i++) v[i]! /= norm;
    return v;
  }
}

describe("memory", () => {
  beforeEach(() => {
    db.run("DELETE FROM memory");
    _setMemoryBackend(new FakeBackend());
  });

  test("remember stores text and assigns an id", async () => {
    const e = await remember({ text: "the red bird flies fast" });
    expect(e.id).toBeGreaterThan(0);
    expect(e.text).toBe("the red bird flies fast");
    expect(memoryCount()).toBe(1);
  });

  test("recall ranks closer notes higher", async () => {
    await remember({ text: "the blue fish is slow" });
    await remember({ text: "the red bird flies fast" });
    await remember({ text: "money buys time" });
    const hits = await recall({ query: "fast bird", k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toBe("the red bird flies fast");
  });

  test("recall threshold filters out unrelated notes", async () => {
    await remember({ text: "money buys time" });
    const hits = await recall({ query: "fast bird", threshold: 0.5 });
    expect(hits.length).toBe(0);
  });

  test("tags are persisted as an array", async () => {
    await remember({ text: "blue fish swim slow", tags: ["aquatic", "calm"] });
    const all = listRecent(10);
    expect(all[0]!.tags).toEqual(["aquatic", "calm"]);
  });

  test("forget deletes by id", async () => {
    const e = await remember({ text: "red bird" });
    expect(forget(e.id)).toBe(true);
    expect(memoryCount()).toBe(0);
    expect(forget(e.id)).toBe(false);
  });

  test("listRecent returns newest first", async () => {
    await remember({ text: "first" });
    await new Promise((r) => setTimeout(r, 2));
    await remember({ text: "second" });
    const rows = listRecent(10);
    expect(rows[0]!.text).toBe("second");
    expect(rows[1]!.text).toBe("first");
  });

  test("recall on empty memory returns []", async () => {
    const hits = await recall({ query: "anything" });
    expect(hits).toEqual([]);
  });

  test("remember rejects empty text", async () => {
    await expect(remember({ text: "   " })).rejects.toThrow();
  });
});
