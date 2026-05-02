// Helpers for reading and writing Float32Array vectors as a SQLite BLOB.
// Stored as little-endian raw bytes; 4 * dim bytes per vector.

export function vectorToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function bufferToVector(buf: Buffer): Float32Array {
  // SQLite returns a Buffer that may not be 4-byte aligned. Copy to be safe.
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(aligned);
}

// The "input text" we embed is the user-facing query distilled from a
// request body. For Anthropic /v1/messages we take the system prompt plus
// the messages array. For OpenAI /v1/chat/completions same idea. We strip
// volatile fields (timestamps, request IDs) so semantically identical
// prompts hash to the same string before embedding.
export function inputTextFor(body: any): string {
  const parts: string[] = [];
  if (body?.system) {
    if (typeof body.system === "string") parts.push(body.system);
    else if (Array.isArray(body.system)) parts.push(body.system.map((s: any) => s.text || "").join("\n"));
  }
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      const role = m.role || "user";
      const content =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
          ? m.content.map((c: any) => c.text || "").join("\n")
          : "";
      parts.push(`[${role}] ${content}`);
    }
  }
  return parts.join("\n").trim();
}
