// MCP stdio server. Exposes anchor's long-term memory store as MCP tools so
// Claude Code, Cursor, Cline, and any other MCP-aware client can call
// `remember` and `recall` directly.
//
// Wire-up in Claude Code:
//   claude mcp add anchor anchor mcp
//
// Wire-up in Cursor (settings.json):
//   "mcpServers": { "anchor": { "command": "anchor", "args": ["mcp"] } }
//
// Transport is line-delimited JSON-RPC 2.0 on stdin/stdout, per the MCP
// stdio spec. Logs go to stderr so they don't pollute the protocol channel.

import { remember, recall, listRecent, forget, memoryCount } from "./memory";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "anchor", version: "0.4.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// MCP tool schemas. The shape follows the JSON Schema subset MCP clients
// understand: type=object with named properties + required list.
const TOOLS = [
  {
    name: "remember",
    description:
      "Save a long-term memory note. Persists across sessions. Optional tags help group related notes.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Note text. Free-form." },
        tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
      },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description:
      "Semantic search over saved memories. Returns the top-k closest notes ranked by cosine similarity.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up." },
        k: { type: "number", description: "How many results to return. Default 5, max 50.", minimum: 1, maximum: 50 },
        threshold: { type: "number", description: "Minimum cosine similarity. Default 0 (return all)." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_memories",
    description: "List the most recently saved memories. Useful for browsing what is stored.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many entries to return. Default 20, max 200.", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "forget_memory",
    description: "Delete a memory by id. The id comes from list_memories or recall results.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Memory id to delete." } },
      required: ["id"],
    },
  },
];

function logErr(...args: unknown[]): void {
  process.stderr.write("[anchor mcp] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
}

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function ok(id: number | string | null, result: any): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: number | string | null, code: number, message: string, data?: any): void {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function asTextContent(value: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

async function handleToolCall(name: string, rawArgs: any): Promise<{ content: any[]; isError?: boolean }> {
  const args = rawArgs ?? {};
  try {
    if (name === "remember") {
      const entry = await remember({
        text: String(args.text ?? ""),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        source: "mcp",
      });
      return asTextContent({ id: entry.id, saved: entry.text, tags: entry.tags });
    }
    if (name === "recall") {
      const hits = await recall({
        query: String(args.query ?? ""),
        k: typeof args.k === "number" ? args.k : undefined,
        threshold: typeof args.threshold === "number" ? args.threshold : undefined,
      });
      if (hits.length === 0) return asTextContent("no matches");
      const lines = hits.map((h) => `#${h.id} (score ${h.score.toFixed(3)}): ${h.text}${h.tags.length ? "  [" + h.tags.join(", ") + "]" : ""}`);
      return asTextContent(lines.join("\n"));
    }
    if (name === "list_memories") {
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const rows = listRecent(limit);
      if (rows.length === 0) return asTextContent("memory is empty");
      const total = memoryCount();
      const lines = [
        `total: ${total} entries`,
        ...rows.map((r) => `#${r.id} ${new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")}  ${r.text}${r.tags.length ? "  [" + r.tags.join(", ") + "]" : ""}`),
      ];
      return asTextContent(lines.join("\n"));
    }
    if (name === "forget_memory") {
      const id = Number(args.id);
      if (!Number.isFinite(id)) return { content: [{ type: "text", text: "id must be a number" }], isError: true };
      const removed = forget(id);
      return asTextContent(removed ? `forgot #${id}` : `no entry #${id}`);
    }
    return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: (e as Error).message }], isError: true };
  }
}

async function dispatch(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize": {
      ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      // Notifications carry no id and expect no response.
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const params = req.params ?? {};
      const result = await handleToolCall(String(params.name), params.arguments);
      ok(id, result);
      return;
    }
    case "resources/list":
    case "prompts/list":
      // We don't expose resources or prompts. Return empty so clients that
      // probe these endpoints don't see method-not-found and disconnect.
      ok(id, req.method === "resources/list" ? { resources: [] } : { prompts: [] });
      return;
    default:
      if (req.id !== undefined) fail(id, -32601, "method not found: " + req.method);
      return;
  }
}

// Test-only export. The stdio loop never exits on its own, so the suite
// drives the protocol by calling dispatch directly with JSON-RPC requests.
export const __dispatch = dispatch;

export async function runMcp(): Promise<void> {
  logErr("starting; tools=" + TOOLS.map((t) => t.name).join(","));
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      let req: JsonRpcRequest;
      try { req = JSON.parse(line); } catch (e) {
        logErr("parse error", (e as Error).message);
        continue;
      }
      dispatch(req).catch((e) => {
        logErr("dispatch error", (e as Error).message);
        if (req.id !== undefined) fail(req.id ?? null, -32603, (e as Error).message);
      });
    }
  });
  process.stdin.on("end", () => {
    logErr("stdin closed, exiting");
    process.exit(0);
  });
  // Keep alive until stdin closes.
  await new Promise<void>(() => {});
}
