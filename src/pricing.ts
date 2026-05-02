// Per-million-token USD list prices used to estimate spend.
// Updated: May 2026. Adjust when providers change pricing.

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-7":  { input: 15,  output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-opus-4-6":  { input: 15,  output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-opus-4":    { input: 15,  output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },

  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4":   { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },

  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  "claude-haiku-4":   { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },

  "gpt-4o":      { input: 2.5,  output: 10,  cacheWrite5m: 2.5,  cacheWrite1h: 2.5,  cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheWrite5m: 0.15, cacheWrite1h: 0.15, cacheRead: 0.075 },

  "gemini-2.5-flash":      { input: 0.10, output: 0.40, cacheWrite5m: 0.10, cacheWrite1h: 0.10, cacheRead: 0.025 },
  "gemini-2.5-flash-lite": { input: 0.05, output: 0.20, cacheWrite5m: 0.05, cacheWrite1h: 0.05, cacheRead: 0.0125 },

  "deepseek-chat": { input: 0.27, output: 1.10, cacheWrite5m: 0.27, cacheWrite1h: 0.27, cacheRead: 0.07 },
};

const FAMILIES: Array<[RegExp, ModelPrice]> = [
  [/opus/i,   PRICES["claude-opus-4-7"]!],
  [/sonnet/i, PRICES["claude-sonnet-4-6"]!],
  [/haiku/i,  PRICES["claude-haiku-4-5"]!],
  [/gpt-4o-mini/i, PRICES["gpt-4o-mini"]!],
  [/gpt-4/i,  PRICES["gpt-4o"]!],
  [/gemini.*flash.*lite/i, PRICES["gemini-2.5-flash-lite"]!],
  [/gemini.*flash/i, PRICES["gemini-2.5-flash"]!],
  [/deepseek/i, PRICES["deepseek-chat"]!],
];

export function priceFor(model: string): ModelPrice {
  const cleaned = (model || "").replace(/\[.*?\]/g, "").replace(/-\d{8}$/, "");
  if (PRICES[cleaned]) return PRICES[cleaned]!;
  for (const [re, p] of FAMILIES) if (re.test(cleaned)) return p;
  return PRICES["claude-sonnet-4-6"]!;
}

export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export function costUsd(t: Tokens, model: string): number {
  const p = priceFor(model);
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h +
      t.cacheRead * p.cacheRead) /
    1_000_000
  );
}
