// Embedding backend for the semantic-fuzzy cache. v0.2 will plug a real
// model in here. The interface is pinned now so the rest of the cache code
// can be written against it.
//
// Two candidate backends:
//   - fastembed-js with a small ONNX model (BGE-small or all-MiniLM-L6),
//     runs entirely in-process, no network. Adds ~30-60MB to the binary.
//   - server-mode: optional HTTP endpoint pointing at a running embeddings
//     service (e.g. a local Ollama with nomic-embed-text). Zero startup cost
//     but adds a network hop per cache lookup.
//
// We will likely ship fastembed by default and let users opt into a server
// via ANCHOR_EMBEDDINGS_URL.

export interface EmbeddingBackend {
  /** Stable identifier for the model. Used in the cache key namespace so
   *  embeddings from different models do not get mixed. */
  id: string;
  /** Vector dimension. */
  dim: number;
  /** Returns a unit-normalized vector for the input string. */
  embed(text: string): Promise<Float32Array>;
}

export class NoOpBackend implements EmbeddingBackend {
  id = "noop";
  dim = 0;
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(0);
  }
}

let active: EmbeddingBackend = new NoOpBackend();

export function getBackend(): EmbeddingBackend {
  return active;
}

export function setBackend(backend: EmbeddingBackend): void {
  active = backend;
}

// Cosine similarity between two unit-normalized vectors. With normalized
// vectors this is just the dot product, but we accept arbitrary input here.
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
