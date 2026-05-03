import { describe, expect, test } from "bun:test";
import { cosine } from "../src/embeddings";

describe("cosine", () => {
  test("identical vectors score 1", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });

  test("orthogonal vectors score 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosine(a, b)).toBe(0);
  });

  test("opposite vectors score -1", () => {
    const a = new Float32Array([1, 1]);
    const b = new Float32Array([-1, -1]);
    expect(cosine(a, b)).toBeCloseTo(-1, 6);
  });

  test("mismatched lengths score 0", () => {
    expect(cosine(new Float32Array([1]), new Float32Array([1, 2]))).toBe(0);
  });

  test("empty vectors score 0", () => {
    expect(cosine(new Float32Array(), new Float32Array())).toBe(0);
  });
});
