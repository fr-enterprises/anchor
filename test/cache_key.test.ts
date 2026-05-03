import { describe, expect, test } from "bun:test";
import { keyOf } from "../src/cache";

describe("keyOf", () => {
  test("identical bodies hash identically", () => {
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
    const a = keyOf({ provider: "anthropic", model: "claude-sonnet-4-5", body });
    const b = keyOf({ provider: "anthropic", model: "claude-sonnet-4-5", body });
    expect(a).toBe(b);
  });

  test("stream flag splits the key", () => {
    const base = { messages: [{ role: "user", content: "hi" }] };
    const a = keyOf({ provider: "anthropic", model: "x", body: { ...base, stream: false } });
    const b = keyOf({ provider: "anthropic", model: "x", body: { ...base, stream: true } });
    expect(a).not.toBe(b);
  });

  test("model change splits the key", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const a = keyOf({ provider: "anthropic", model: "claude-opus-4-7", body });
    const b = keyOf({ provider: "anthropic", model: "claude-haiku-4-5", body });
    expect(a).not.toBe(b);
  });

  test("temperature change splits the key", () => {
    const a = keyOf({ provider: "openai", model: "gpt-4o", body: { messages: [], temperature: 0 } });
    const b = keyOf({ provider: "openai", model: "gpt-4o", body: { messages: [], temperature: 0.7 } });
    expect(a).not.toBe(b);
  });
});
