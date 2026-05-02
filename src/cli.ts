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

const VERSION = "0.1.0";

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
