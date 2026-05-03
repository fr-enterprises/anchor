<div align="center">

# anchor

local proxy that caches your AI API calls and tracks spend.

[![release](https://img.shields.io/github/v/release/fr-enterprises/anchor?style=flat-square&color=000)](https://github.com/fr-enterprises/anchor/releases)
[![ci](https://img.shields.io/github/actions/workflow/status/fr-enterprises/anchor/ci.yml?branch=main&style=flat-square&color=000&label=ci)](https://github.com/fr-enterprises/anchor/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/fr-enterprises/anchor?style=flat-square&color=000)](LICENSE)
[![downloads](https://img.shields.io/github/downloads/fr-enterprises/anchor/total?style=flat-square&color=000)](https://github.com/fr-enterprises/anchor/releases)

<img src=".github/assets/demo.gif" alt="anchor caches API calls and tracks spend" width="780">

</div>

```sh
anchor proxy
export ANTHROPIC_BASE_URL=http://localhost:7777
```

every Claude / OpenAI call your tools make now goes through anchor first. identical requests come back from cache, costing zero. anchor logs every call and tells you exactly how much you spent and saved.

100% local. nothing leaves your machine. no telemetry, no SaaS, no account.

## why

Claude Code, Cursor, Cline, Aider all hit the API every turn. open any of them for a few hours and the bill is real. lots of those calls are identical or near-identical. paying for the same answer twice is silly.

anchor sits between your tool and the upstream API:

```
your tool   anchor cache   upstream
   |             |             |
   +--- POST --->|             |
                 | hit?        |
                 +-- yes ------+ (no upstream call, $0)
                 +-- no ------>|
                 |             +-- response
                 |<------------+
                 | store
                 +-- response
```

cache hits cost nothing. misses are forwarded as-is, response stored, future identical asks served free.

## install

```sh
curl -fsSL https://raw.githubusercontent.com/fr-enterprises/anchor/main/install.sh | bash
```

or grab a binary from [Releases](https://github.com/fr-enterprises/anchor/releases). single static binary, no node, no python, no docker.

## use

start the proxy:

```sh
anchor proxy
```

point your tools at it (in a shell rc file or per-project .env):

```sh
export ANTHROPIC_BASE_URL=http://localhost:7777
export OPENAI_BASE_URL=http://localhost:7777/v1
```

now every Claude Code / Cursor / Cline / Aider / your-script call routes through anchor. nothing else changes.

check what you saved:

```sh
$ anchor stats today

  spent      $0.42
  saved      $0.18  (30% of total)
  requests   47  (12 hits, 35 misses, 26% hit rate)
```

```sh
$ anchor stats week --by-day

  spent      $4.83
  saved      $2.11  (30% of total)
  ...

by day
  2026-05-02   spent    $0.42   saved    $0.18   12h 35m
  2026-05-01   spent    $1.10   saved    $0.50   18h 71m
  ...
```

## what gets cached

requests are cached when:

- request body is JSON (Anthropic /v1/messages or OpenAI /v1/chat/completions)
- key is the SHA-256 of model + system + messages + max_tokens + temperature + tools + response_format + stream

if any of those changes, key changes, cache misses, upstream is called.

since v0.3, streaming requests are cached too. anchor tees the upstream SSE on miss, stores the raw bytes, and replays them on hit as a normal `text/event-stream`. streaming and non-streaming variants of the same prompt get separate cache entries (replay paths differ). usage is parsed from Anthropic `message_start`/`message_delta` events and from OpenAI's final `usage` chunk when the client opts into `stream_options.include_usage`.

since v0.2, exact-match miss can fall through to a semantic lookup: anchor embeds your prompt, scans previously cached requests, and returns the closest match if cosine similarity is above a threshold (default 0.95). off by default. enable with:

```sh
export ANCHOR_SEMANTIC=1
export OPENAI_API_KEY=sk-...   # used only for the embedding call
```

the semantic match only fires across the same provider+model. responses come back with `x-anchor-cache: semantic` and `x-anchor-semantic-score`. tighten with `ANCHOR_SEMANTIC_THRESHOLD=0.97` if you want fewer fuzzy hits, loosen for more savings.

## long-term memory

since v0.4, anchor ships a long-term memory store separate from the request cache. notes persist across sessions and are searched semantically.

from the CLI:

```sh
anchor remember "rotated the auth keys 2026-05-03" --tag security
anchor recall "auth rotation"        # semantic search, ranked
anchor memory list --limit 20
anchor memory forget 42
```

from Claude Code or Cursor, anchor exposes the same store as an MCP server over stdio. wire it up once and the model can call `remember` and `recall` mid-conversation.

```sh
# Claude Code
claude mcp add anchor anchor mcp

# Cursor — settings.json
{
  "mcpServers": {
    "anchor": { "command": "anchor", "args": ["mcp"] }
  }
}
```

memory uses the same OpenAI embeddings backend as the cache, so one `OPENAI_API_KEY` covers both features. text and vectors live in the same SQLite store at `~/.anchor/anchor.db`. nothing else leaves your machine.

## privacy

- 100% local. proxy listens on 127.0.0.1 by default.
- store at `~/.anchor/anchor.db` (SQLite).
- no telemetry. anchor does not phone home.
- no account. no signup.
- responses are stored as raw bytes for replay. wipe with `anchor cache clear`.

## commands

| | |
|---|---|
| `anchor proxy [--port N] [--host H] [--verbose]` | start the proxy |
| `anchor stats [today\|week\|month\|all] [--by-day\|--by-model\|--by-source]` | spend + savings |
| `anchor cache` | cache size |
| `anchor cache clear` | wipe cache |
| `anchor remember "note" [--tag x]` | save a long-term memory note |
| `anchor recall "query" [--k 5]` | semantic search over memory |
| `anchor memory list [--limit 20]` | list recent memories |
| `anchor memory forget <id>` | delete a memory |
| `anchor mcp` | run as an MCP stdio server (Claude Code, Cursor) |
| `anchor health` | check if proxy is running |
| `anchor version` | print version |

## env vars

| | |
|---|---|
| `ANTHROPIC_UPSTREAM` | upstream URL for Anthropic, default `https://api.anthropic.com`. point this at a Cloudflare Worker proxy if your VPS region is blocked. |
| `OPENAI_UPSTREAM` | upstream URL for OpenAI, default `https://api.openai.com` |
| `ANCHOR_PORT` | proxy port, default `7777` |
| `ANCHOR_HOST` | proxy host, default `127.0.0.1` |
| `ANCHOR_SEMANTIC` | set to `1` to enable semantic-fuzzy cache (requires `OPENAI_API_KEY` for embeddings) |
| `ANCHOR_SEMANTIC_THRESHOLD` | cosine threshold for semantic hits, default `0.95` |
| `OPENAI_EMBEDDINGS_URL` | override embeddings endpoint (default `https://api.openai.com/v1/embeddings`) |
| `NO_COLOR` | drop ANSI codes from CLI output |

## roadmap

| version | what |
|---|---|
| v0.1  | exact-match cache, spend tracker |
| v0.2  | semantic-fuzzy cache via embeddings |
| v0.3  | streaming-aware cache |
| **v0.4** | MCP server: long-term memory for Claude Code / Cursor (you are here) |
| v0.5  | smart routing: cheap model for simple prompts, premium for hard |
| v0.6  | anti-compact: smart context window management for long sessions |
| v1.0  | polished: brew formula, demo, launch |

## not goals

- not a SaaS
- not a paid tier
- not "AI optimization" with telemetry
- not yet another agent framework

## license

MIT
