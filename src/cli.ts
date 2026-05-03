#!/usr/bin/env bun
// anchor: local proxy that caches AI API calls and tracks spend.
//
//   anchor proxy [--port 7777] [--host 127.0.0.1] [--verbose]
//   anchor stats [--since today|week|month]
//   anchor cache clear
//   anchor health
//   anchor version
//
// Point your tool at it:
//   export ANTHROPIC_BASE_URL=http://localhost:7777
//   export OPENAI_BASE_URL=http://localhost:7777/v1

import { start } from "./proxy";
import { cacheStats, clearCache } from "./cache";
import { summary, totals } from "./spend";
import { dbPath } from "./db";
import { remember, recall, listRecent, forget, memoryCount } from "./memory";
import { runMcp } from "./mcp";

const VERSION = "0.3.0";

const NOCOLOR = !!process.env.NO_COLOR || !process.stdout.isTTY;
const C = (open: string) => (s: string) => (NOCOLOR ? s : `${open}${s}\x1b[0m`);
const bold = C("\x1b[1m");
const dim = C("\x1b[2m");
const green = C("\x1b[32m");
const red = C("\x1b[31m");
const cyan = C("\x1b[36m");

function fmt(n: number): string {
  if (n >= 100)    return "$" + n.toFixed(0);
  if (n >= 1)      return "$" + n.toFixed(2);
  if (n >= 0.01)   return "$" + n.toFixed(3);
  if (n >= 0.0001) return "$" + n.toFixed(5);
  if (n > 0)       return "$" + n.toFixed(6);
  return "$0";
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}

function sinceTs(spec: string | undefined): number {
  const now = Date.now();
  if (!spec || spec === "today") {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  if (spec === "week")  return now - 7 * 86400_000;
  if (spec === "month") return now - 30 * 86400_000;
  if (spec === "all")   return 0;
  const ms = Number(spec);
  return Number.isFinite(ms) ? ms : now - 86400_000;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function cmdProxy(args: string[]) {
  const port = Number(flagValue(args, "--port")) || Number(process.env.ANCHOR_PORT) || 7777;
  const host = flagValue(args, "--host") || process.env.ANCHOR_HOST || "127.0.0.1";
  const verbose = args.includes("--verbose") || args.includes("-v");

  const server = start({ port, host, verbose });
  console.log(bold("anchor") + " " + dim("v" + VERSION) + " proxy listening on " + green(`http://${host}:${port}`));
  console.log(dim("  point your tool: ") + "ANTHROPIC_BASE_URL=" + green(`http://${host}:${port}`));
  console.log(dim("                   ") + "OPENAI_BASE_URL=" + green(`http://${host}:${port}/v1`));
  console.log(dim("  store: " + dbPath));
  if (verbose) console.log(dim("  verbose: ON (cache hit/miss logging)"));

  // Keep the process alive.
  process.on("SIGINT", () => {
    console.log("\n" + dim("anchor stopped"));
    server.stop();
    process.exit(0);
  });
}

function cmdStats(args: string[]) {
  const since = sinceTs(flagValue(args, "--since") || args[0]);

  const t = totals({ sinceTs: since });
  const totalReq = t.hits + t.misses;
  const hitRate = totalReq > 0 ? (t.hits / totalReq) * 100 : 0;

  console.log("");
  console.log(bold("anchor") + dim(" since " + (args[0] || "today")));
  console.log("");
  console.log("  spent      " + green(fmt(t.spent)));
  console.log("  saved      " + cyan(fmt(t.saved)) + dim("   (" + (t.spent + t.saved > 0 ? Math.round((t.saved / (t.spent + t.saved)) * 100) : 0) + "% of total)"));
  console.log("  requests   " + (totalReq) + dim("  (" + t.hits + " hits, " + t.misses + " misses, " + hitRate.toFixed(0) + "% hit rate)"));
  console.log("");

  if (args.includes("--by-day") || args.includes("-d")) {
    const rows = summary({ sinceTs: since, by: "day" });
    console.log(bold("by day"));
    for (const r of rows) {
      console.log("  " + r.bucket + "   spent " + fmt(r.costUsd).padStart(8) + "   saved " + fmt(r.savedUsd).padStart(8) + dim("   " + r.hits + "h " + r.misses + "m"));
    }
    console.log("");
  }

  if (args.includes("--by-model") || args.includes("-m")) {
    const rows = summary({ sinceTs: since, by: "model" });
    console.log(bold("by model"));
    for (const r of rows) {
      console.log("  " + r.bucket.padEnd(28) + " spent " + fmt(r.costUsd).padStart(8) + "   saved " + fmt(r.savedUsd).padStart(8));
    }
    console.log("");
  }

  if (args.includes("--by-source") || args.includes("-s")) {
    const rows = summary({ sinceTs: since, by: "source" });
    console.log(bold("by source"));
    for (const r of rows) {
      console.log("  " + r.bucket.padEnd(20) + " spent " + fmt(r.costUsd).padStart(8) + "   saved " + fmt(r.savedUsd).padStart(8));
    }
    console.log("");
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({
      since,
      totals: t,
      hitRate,
      cache: cacheStats(),
    }, null, 2));
  }
}

function cmdCache(args: string[]) {
  if (args[0] === "clear") {
    const removed = clearCache();
    console.log(green("✓") + " cleared " + removed + " entries");
    return;
  }
  const stats = cacheStats();
  console.log("entries: " + stats.entries);
  console.log("size:    " + (stats.bytes / 1024).toFixed(1) + " KB");
}

async function cmdRemember(args: string[]) {
  const text = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!text) {
    console.error(red("usage: ") + "anchor remember \"note text\" [--tag work --tag api]");
    process.exit(1);
  }
  const tags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tag" && args[i + 1]) tags.push(args[++i]!);
  }
  const source = flagValue(args, "--source") || "cli";
  const entry = await remember({ text, tags, source });
  console.log(green("✓") + " #" + entry.id + dim("  ") + entry.text);
  if (tags.length) console.log(dim("  tags: " + tags.join(", ")));
}

async function cmdRecall(args: string[]) {
  const k = Number(flagValue(args, "--k")) || 5;
  const threshold = Number(flagValue(args, "--threshold"));
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--k" && args[i - 1] !== "--threshold");
  const query = positional.join(" ").trim();
  if (!query) {
    console.error(red("usage: ") + "anchor recall \"what was that thing about X\" [--k 5]");
    process.exit(1);
  }
  const hits = await recall({ query, k, threshold: Number.isFinite(threshold) ? threshold : 0 });
  if (hits.length === 0) {
    console.log(dim("no matches"));
    return;
  }
  for (const h of hits) {
    console.log(cyan(h.score.toFixed(3)) + dim("  #" + h.id + "  ") + h.text);
    if (h.tags.length) console.log(dim("       tags: " + h.tags.join(", ")));
  }
}

function cmdMemory(args: string[]) {
  const sub = args[0];
  if (sub === "list" || sub === undefined) {
    const limit = Number(flagValue(args.slice(1), "--limit")) || 20;
    const rows = listRecent(limit);
    if (rows.length === 0) {
      console.log(dim("memory is empty"));
      return;
    }
    console.log(dim("total: " + memoryCount() + " entries"));
    for (const r of rows) {
      const date = new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ");
      console.log(dim(date) + "  #" + String(r.id).padEnd(4) + r.text);
      if (r.tags.length) console.log(dim("                       tags: " + r.tags.join(", ")));
    }
    return;
  }
  if (sub === "forget") {
    const id = Number(args[1]);
    if (!Number.isFinite(id)) {
      console.error(red("usage: ") + "anchor memory forget <id>");
      process.exit(1);
    }
    const ok = forget(id);
    console.log(ok ? green("✓") + " forgot #" + id : red("✕") + " no entry #" + id);
    if (!ok) process.exit(1);
    return;
  }
  console.error(red("unknown memory subcommand: ") + sub);
  process.exit(1);
}

async function cmdHealth() {
  const port = Number(process.env.ANCHOR_PORT) || 7777;
  const host = process.env.ANCHOR_HOST || "127.0.0.1";
  try {
    const r = await fetch(`http://${host}:${port}/__anchor/health`);
    const j: any = await r.json();
    console.log(green("✓") + " proxy up on " + host + ":" + port + dim("  cache: " + j.entries + " entries"));
  } catch {
    console.log(red("✕") + " proxy not running on " + host + ":" + port);
    console.log(dim("  start it: anchor proxy"));
    process.exit(1);
  }
}

function help() {
  console.log(`${bold("anchor")} ${dim("v" + VERSION)}  local proxy that caches AI API calls and tracks spend.

${bold("Usage")}
  anchor proxy [--port 7777] [--host 127.0.0.1] [--verbose]
  anchor stats [today|week|month|all] [--by-day] [--by-model] [--by-source] [--json]
  anchor cache         show cache size
  anchor cache clear   wipe the cache
  anchor remember "note" [--tag work]    save a long-term memory
  anchor recall "query" [--k 5]          semantic search over memory
  anchor memory list [--limit 20]        list recent memories
  anchor memory forget <id>              delete a memory
  anchor mcp           start an MCP stdio server (Claude Code, Cursor, etc.)
  anchor health        check if the proxy is running
  anchor version

${bold("Hook your tool up")}
  export ANTHROPIC_BASE_URL=http://localhost:7777
  export OPENAI_BASE_URL=http://localhost:7777/v1

${dim("Free, OSS, MIT. No telemetry. Nothing leaves your machine.")}
`);
}

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case "proxy": case "serve":
      await cmdProxy(args);
      break;
    case "stats":
      cmdStats(args);
      break;
    case "cache":
      cmdCache(args);
      break;
    case "remember":
      await cmdRemember(args);
      break;
    case "recall":
      await cmdRecall(args);
      break;
    case "memory":
      cmdMemory(args);
      break;
    case "mcp":
      await runMcp();
      break;
    case "health":
      await cmdHealth();
      break;
    case "version": case "-v": case "--version":
      console.log(VERSION);
      break;
    case undefined: case "help": case "-h": case "--help":
      help();
      break;
    default:
      console.error(red("unknown command: ") + cmd);
      help();
      process.exit(1);
  }
} catch (e) {
  console.error(red("error: ") + (e as Error).message);
  process.exit(1);
}
