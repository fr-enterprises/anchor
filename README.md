<div align="center">

# anchor

local proxy that caches your AI API calls and tracks spend.

[![release](https://img.shields.io/github/v/release/f4rkh4d/anchor?style=flat-square&color=000)](https://github.com/f4rkh4d/anchor/releases)
[![license](https://img.shields.io/github/license/f4rkh4d/anchor?style=flat-square&color=000)](LICENSE)
[![downloads](https://img.shields.io/github/downloads/f4rkh4d/anchor/total?style=flat-square&color=000)](https://github.com/f4rkh4d/anchor/releases)

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
curl -fsSL https://raw.githubusercontent.com/f4rkh4d/anchor/main/install.sh | bash
```

or grab a binary from [Releases](https://github.com/f4rkh4d/anchor/releases). single static binary, no node, no python, no docker.

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
- not streaming (`stream: false` or absent)
- key is the SHA-256 of model + system + messages + max_tokens + temperature + tools + response_format

if any of those changes, key changes, cache misses, upstream is called. exact match only in v0.1. semantic-fuzzy match arrives in v0.2.

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
| `anchor health` | check if proxy is running |
| `anchor version` | print version |

## env vars

| | |
|---|---|
| `ANTHROPIC_UPSTREAM` | upstream URL for Anthropic, default `https://api.anthropic.com`. point this at a Cloudflare Worker proxy if your VPS region is blocked. |
| `OPENAI_UPSTREAM` | upstream URL for OpenAI, default `https://api.openai.com` |
| `ANCHOR_PORT` | proxy port, default `7777` |
| `ANCHOR_HOST` | proxy host, default `127.0.0.1` |
| `NO_COLOR` | drop ANSI codes from CLI output |

## roadmap

| version | what |
|---|---|
| **v0.1** | exact-match cache, spend tracker (you are here) |
| v0.2  | semantic-fuzzy cache (local embeddings), streaming-aware cache |
| v0.3  | smart routing: cheap model for simple prompts, premium for hard |
| v0.4  | MCP server: long-term memory tools for Claude Code / Cursor |
| v0.5  | anti-compact: smart context window management for long sessions |
| v1.0  | polished: brew formula, demo, launch |

## not goals

- not a SaaS
- not a paid tier
- not "AI optimization" with telemetry
- not yet another agent framework

## license

MIT
