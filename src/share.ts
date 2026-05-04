// share.ts: build a public HTML dashboard from anchor stats and POST it to a share endpoint.
// configured via env or settings: ANCHOR_SHARE_URL, ANCHOR_SHARE_SECRET.
// the default endpoint (anchor-share.farkhadbennett.workers.dev) is f4rkh4d's own deployment;
// other users should set their own ANCHOR_SHARE_URL or self-host worker.js from
// github.com/f4rkh4d/anchor-share.

import { totals, summary, type SummaryRow } from "./spend";
import { db } from "./db";

const DEFAULT_SHARE_URL = "https://anchor-share.farkhadbennett.workers.dev";

interface ShareData {
  generatedAt: number;
  sinceTs: number;
  rangeLabel: string;
  totals: ReturnType<typeof totals>;
  byDay: SummaryRow[];
  byModel: SummaryRow[];
  bySource: SummaryRow[];
  hitRate: number;
  totalRequests: number;
}

export function gatherShareData(sinceTs: number, rangeLabel: string): ShareData {
  const t = totals({ sinceTs });
  const totalRequests = t.hits + t.misses;
  return {
    generatedAt: Date.now(),
    sinceTs,
    rangeLabel,
    totals: t,
    byDay: summary({ sinceTs, by: "day" }),
    byModel: summary({ sinceTs, by: "model" }),
    bySource: summary({ sinceTs, by: "source" }),
    hitRate: totalRequests > 0 ? (t.hits / totalRequests) * 100 : 0,
    totalRequests,
  };
}

export function renderShareHtml(d: ShareData): string {
  const t = d.totals;
  const fmt = (n: number) => "$" + n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2);
  const num = (n: number) => n.toLocaleString("en-US");
  const pct = (n: number) => n.toFixed(0) + "%";
  const totalUsage = t.spent + t.saved;
  const savedPct = totalUsage > 0 ? (t.saved / totalUsage) * 100 : 0;

  const maxDay = Math.max(1, ...d.byDay.map((r) => r.costUsd + r.savedUsd));
  const dayBars = d.byDay.slice(-30).map((r) => {
    const total = r.costUsd + r.savedUsd;
    const h = Math.round((total / maxDay) * 100);
    const savedH = total > 0 ? Math.round((r.savedUsd / total) * h) : 0;
    return {
      label: r.bucket,
      heightPct: h,
      savedHeightPct: savedH,
      total,
      saved: r.savedUsd,
      spent: r.costUsd,
    };
  });

  const modelRows = d.byModel.slice(0, 10);
  const sourceRows = d.bySource.slice(0, 10);
  const generated = new Date(d.generatedAt).toISOString().slice(0, 19).replace("T", " ") + " UTC";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>anchor stats . saved ${fmt(t.saved)}</title>
<meta name="description" content="local AI proxy + cache. saved ${fmt(t.saved)} on ${num(d.totalRequests)} requests, ${pct(d.hitRate)} cache hit rate.">
<meta property="og:title" content="anchor: saved ${fmt(t.saved)} caching AI API calls">
<meta property="og:description" content="${num(d.totalRequests)} requests, ${pct(d.hitRate)} cache hit rate, ${d.rangeLabel}.">
<style>
  :root { --ink: #1a1a1a; --bg: #fbfbf8; --muted: #6b6b63; --line: #e5e3dc; --good: #134e3a; --hit: #34d399; --miss: #d8d6cf; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1rem; font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
  .wrap { max-width: 760px; margin: 0 auto; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 2rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); font-size: .92rem; }
  .badge { display: inline-block; padding: .15rem .5rem; background: var(--good); color: var(--bg); border-radius: 999px; font-size: .75rem; vertical-align: middle; margin-left: .4rem; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 2.5rem; }
  .card { padding: 1.25rem; border: 1px solid var(--line); border-radius: 10px; background: white; }
  .card .label { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 2rem; font-weight: 600; margin-top: .25rem; line-height: 1.1; }
  .card .hint { font-size: .85rem; color: var(--muted); margin-top: .25rem; }
  .saved .value { color: var(--good); }
  section { margin-bottom: 2.5rem; }
  h2 { font-size: 1rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 1rem; }
  .chart { display: flex; align-items: flex-end; gap: 4px; height: 160px; padding-bottom: 1.5rem; border-bottom: 1px solid var(--line); position: relative; }
  .col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; position: relative; }
  .bar { width: 100%; background: var(--miss); border-radius: 2px 2px 0 0; position: relative; min-height: 1px; }
  .bar .saved { position: absolute; left: 0; right: 0; bottom: 0; background: var(--hit); border-radius: 2px 2px 0 0; }
  .col .lbl { position: absolute; bottom: -1.3rem; font-size: .65rem; color: var(--muted); white-space: nowrap; }
  .col .lbl.minor { display: none; }
  .col:first-child .lbl, .col:last-child .lbl, .col:nth-child(8n+1) .lbl { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; }
  td, th { padding: .5rem .25rem; text-align: left; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 1rem; font-size: .8rem; color: var(--muted); margin-bottom: .5rem; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: .35rem; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: .85rem; color: var(--muted); }
  footer a { color: var(--good); }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr 1fr; } .card.full { grid-column: 1 / -1; } body { padding: 1rem .75rem; } }
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>anchor stats <span class="badge">live</span></h1>
  <div class="sub">${escapeHtml(d.rangeLabel)} . generated ${escapeHtml(generated)}</div>
</header>

<div class="grid">
  <div class="card saved">
    <div class="label">saved</div>
    <div class="value">${fmt(t.saved)}</div>
    <div class="hint">${pct(savedPct)} of total usage avoided via cache</div>
  </div>
  <div class="card">
    <div class="label">spent</div>
    <div class="value">${fmt(t.spent)}</div>
    <div class="hint">on ${num(t.misses)} cache misses</div>
  </div>
  <div class="card">
    <div class="label">cache hit rate</div>
    <div class="value">${pct(d.hitRate)}</div>
    <div class="hint">${num(t.hits)} of ${num(d.totalRequests)} requests</div>
  </div>
</div>

${d.byDay.length > 0 ? `
<section>
  <h2>by day</h2>
  <div class="legend">
    <span><span class="swatch" style="background: var(--hit)"></span>saved</span>
    <span><span class="swatch" style="background: var(--miss)"></span>spent</span>
  </div>
  <div class="chart">
    ${dayBars.map((b) => `
      <div class="col" title="${escapeHtml(b.label)}: ${fmt(b.saved)} saved, ${fmt(b.spent)} spent">
        <div class="bar" style="height: ${b.heightPct}%">
          <div class="saved" style="height: ${b.heightPct > 0 ? Math.round((b.saved / (b.total || 1)) * 100) : 0}%"></div>
        </div>
        <span class="lbl">${escapeHtml(b.label.slice(5))}</span>
      </div>
    `).join("")}
  </div>
</section>` : ""}

${modelRows.length > 0 ? `
<section>
  <h2>by model</h2>
  <table>
    <thead><tr><th>model</th><th class="num">spent</th><th class="num">saved</th><th class="num">requests</th></tr></thead>
    <tbody>
      ${modelRows.map((r) => `<tr><td>${escapeHtml(r.bucket)}</td><td class="num">${fmt(r.costUsd)}</td><td class="num">${fmt(r.savedUsd)}</td><td class="num">${num(r.hits + r.misses)}</td></tr>`).join("")}
    </tbody>
  </table>
</section>` : ""}

${sourceRows.length > 0 ? `
<section>
  <h2>by source</h2>
  <table>
    <thead><tr><th>tool</th><th class="num">spent</th><th class="num">saved</th><th class="num">requests</th></tr></thead>
    <tbody>
      ${sourceRows.map((r) => `<tr><td>${escapeHtml(r.bucket)}</td><td class="num">${fmt(r.costUsd)}</td><td class="num">${fmt(r.savedUsd)}</td><td class="num">${num(r.hits + r.misses)}</td></tr>`).join("")}
    </tbody>
  </table>
</section>` : ""}

<footer>
  generated locally with <a href="https://github.com/fr-enterprises/anchor">anchor</a>. local proxy that caches AI API calls and tracks spend. nothing leaves your machine except this dashboard.
  <br><br>
  <code>curl -fsSL https://raw.githubusercontent.com/fr-enterprises/anchor/main/install.sh | bash</code>
</footer>

</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readSetting(key: string): string | null {
  try {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function uploadShare(html: string): Promise<{ url: string; id: string }> {
  const url = process.env.ANCHOR_SHARE_URL || readSetting("share.url") || DEFAULT_SHARE_URL;
  const secret = process.env.ANCHOR_SHARE_SECRET || readSetting("share.secret") || "";

  if (!secret) {
    throw new Error(
      "no share secret configured. set ANCHOR_SHARE_SECRET env var, or run\n" +
      "  anchor stats --share-secret <secret>\n" +
      "to store one. f4rkh4d's secret is in his local notes; for self-hosting see\n" +
      "github.com/f4rkh4d/anchor-share."
    );
  }

  const res = await fetch(url.replace(/\/$/, "") + "/upload", {
    method: "POST",
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-share-auth": secret,
    },
    body: html,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error("share endpoint " + res.status + ": " + body.slice(0, 200));
  }

  const data = await res.json() as { id: string; url: string };
  if (!data.url || !data.id) throw new Error("invalid response from share endpoint");
  return data;
}

export function setShareSecret(secret: string): void {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("share.secret", secret);
}

export function setShareUrl(url: string): void {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("share.url", url);
}
