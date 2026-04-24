# pi-hindsight

*Memory that compounds, not clutters.*

Persistent memory for Pi, backed by a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. Install it, point it at your server, and memory works automatically from the first session.

**Best fit for:**
- Self-hosted Hindsight users who want full data control
- Long-lived repo work where context carries across sessions
- Users who want per-prompt memory controls (`#nomem`, `#global`, `#tags`)
- Anyone who prefers a minimal, single-file extension with zero extra dependencies

## Requirements

This extension connects to a **self-hosted Hindsight server**. It does not include or manage the backend.

You need a running [Hindsight](https://github.com/vectorize-io/hindsight) server.

If you don't have a Hindsight server yet, follow the [Hindsight getting started guide](https://hindsight.vectorize.io/developer/api/quickstart) first, then come back here.

## Install

```bash
pi install npm:pi-hindsight
```

Or from GitHub:

```bash
pi install git:github.com/anh-chu/pi-hindsight
```

## Quick start

1. **Install** the extension (see above).

2. **Configure** your Hindsight server in `~/.hindsight/config`:
   ```toml
   api_url = "http://your-hindsight-server:8888"
   api_key = "<API_KEY>"
   global_bank = "optional-global-bank-id"
   ```

3. **Verify** in Pi:
   ```
   /hindsight status
   ```

That's it. Memory is fully automatic from here: recall before each turn, retain after each turn, no manual intervention needed.

## Features

### Automatic memory lifecycle

- **Auto-recall:** Before each agent turn, relevant memories from your project and global banks are injected into the prompt.
- **Auto-retain:** After each agent turn, the conversation is appended to a per-session memory document. Only the new delta is processed, no redundant work.
- **Feedback loop prevention:** Memory blocks are stripped from retained content. No recursive memory bloat.
- **Noise filtering:** Low-signal tool calls (bash, read, write, edit) are dropped from retained transcripts. Conversation and meaningful tool usage are kept.

### Per-prompt controls

- `#nomem` or `#skip`: skip retain for this turn (sensitive or throwaway prompts).
- `#global` or `#me`: also retain this turn to your global bank (cross-project learnings).
- `#architecture`, `#bug`, etc.: custom tags extracted and attached to memory for filtering.

### In-chat visibility

| Event | What you see |
|-------|-------------|
| Recall | 🧠 Hindsight recalled N memories + snippet |
| Retain (success) | 💾 Hindsight saved turn to memory → bank-name |
| Retain (failure) | 💾 Hindsight retain failed, use hindsight_retain to save manually |

### Manual tools

- `hindsight_recall`: Pull additional context from memory on demand.
- `hindsight_retain`: Force-save a specific insight.
- `hindsight_reflect`: Ask Hindsight to synthesize an answer from your memories (server-side reasoning).

## Configuration

### Global config: `~/.hindsight/config`

```toml
api_url          = "http://localhost:8888"
api_key          = "your-api-key"
global_bank      = "sil"
recall_types     = "observation"
recall_budget    = "mid"
recall_max_tokens = 800
async_retain     = true
```

### Project override: `.hindsight/config` (in project root)

Place a `.hindsight/config` file in any project directory to override global settings. Local values win.

```toml
recall_types     = "observation,experience"
recall_budget    = "low"
recall_max_tokens = 512
```

### Config reference

| Key | Default | Description |
|-----|---------|-------------|
| `recall_types` | `observation` | Memory types to search: `observation`, `world`, `experience`. Comma-separated. Each type runs the full retrieval pipeline independently. |
| `recall_budget` | `mid` | Retrieval depth: `low`, `mid`, `high`. Higher = more coverage but added latency. |
| `recall_max_tokens` | Server default (4096) | Max tokens for injected memories. Lower values reduce context noise. Recommended: `800`. |
| `async_retain` | `true` | Non-blocking retain. Set `false` for sync retain with failure notifications. |
| `global_bank` | _(none)_ | Bank ID for cross-project memory. When set, this bank is queried alongside the project bank on every recall. Turns tagged `#global` or `#me` are also retained here. Leave unset if you only want per-project memory. |

## Commands

### `/hindsight status`
Full health check: server reachability, auth, bank access, hook state, debug log tail.

```
URL:    http://localhost:8888
Server: ✓ online
Bank:   project-myapp
  ✓ auth ok
Global: global-bank

Hooks this session:
  session_start:      ✓ ok
  recall:             ✓ ok (3 memories)
  retain:             ✓ ok (project-myapp)

Debug log: disabled (set HINDSIGHT_DEBUG=1 to enable)
```

### `/hindsight stats`
Memory, entity, and document counts for all active banks.

### `/hindsight config`
Show current effective configuration.

## Banks

### Project bank

Named `project-<dirname>` based on your current working directory, created automatically on first use. No setup required. All turns are retained here by default, so each project builds its own isolated memory over time.

### Global bank

Optional. Set `global_bank = <bank-id>` in your config to enable it. The global bank is meant for knowledge that applies across projects: preferred patterns, personal conventions, people and teams you work with, recurring tools.

On each session's first turn, both banks are queried in parallel and their results are merged into a single recall injection. You get project-specific context and cross-project context together, with no duplicated queries.

Turns are retained to the global bank only when you explicitly tag the prompt with `#global` or `#me`. Everything else goes to the project bank only, keeping global memory intentional.

## Debug logging

Set `HINDSIGHT_DEBUG=1` to enable verbose logging to `~/.hindsight/debug.log`. Log tail is shown inline in `/hindsight status`.

## Performance

Recall latency depends primarily on your database indexes and hosting tier. With HNSW indexes on Supabase free tier, expect ~4s for a parallel global + project bank recall.

For benchmarks, latency analysis, recommended settings, and a Supabase index checklist, see **[docs/performance.md](docs/performance.md)**.

## Why Hindsight over other memory approaches

| Approach | Typical tradeoff | Hindsight + this extension |
|---|---|---|
| Markdown/file-based memory | Human-readable, but quality degrades over time | Automatic retain + retrieval, still inspectable |
| Custom vector DB (ChromaDB, etc.) | Flexible, but requires ongoing tuning | Built-in memory model with multi-strategy recall |
| Other Pi memory extensions | Often weak deduplication or limited bank cooperation | Observation-first recall with dedup, project + global bank cooperation |

On every first turn, both your project bank and global bank are queried in parallel. Project memories cover the current codebase; global memories carry patterns and preferences you've built across all your projects. You get both without any extra setup beyond setting `global_bank` in your config.

Hindsight uses semantic, BM25, graph, and temporal retrieval strategies. Entities (people, projects, tools) are recalled as connected context, not isolated snippets. Recent memories rank higher automatically.

## Comparison with [@walodayeet/hindsight-pi](https://github.com/walodayeet/hindsight-pi)

There are two Hindsight extensions for Pi. Both connect to a self-hosted Hindsight server and provide auto-recall and auto-retain. They share the same core goal but differ in philosophy: this extension optimizes for simplicity and per-prompt control, while `@walodayeet/hindsight-pi` optimizes for configurability and operational tooling.

This section aims to help you pick the right one. Both are good.

### At a glance

| Dimension | **pi-hindsight** (this) | **@walodayeet/hindsight-pi** |
|---|---|---|
| Install | `pi install npm:pi-hindsight` | `pi install npm:@walodayeet/hindsight-pi` |
| Backend required | Self-hosted Hindsight server + Postgres (pgvector) + embedding API | Same |
| Extra dependencies | None (raw `fetch`) | `@vectorize-io/hindsight-client` SDK |
| Config format | `.ini` | JSON |
| Codebase | Single file (~450 LOC) | Multi-file modular (~1500 LOC) |

### Recall

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Trigger | `before_agent_start`, first turn only | `before_agent_start` or `context` hook |
| Injection frequency | Implicit (internal `recallDone` flag) | Explicit: `first-turn` or `every-turn` |
| Recall modes | Always auto-inject + manual tools | `hybrid`, `context`, `tools`, or `off` |
| Dual-bank recall | Always queries global + project in parallel | Queries primary bank + optional `globalBankId` |
| Recall types | Configurable, defaults to `observation` | Configurable per-type with `recallPerType` count |
| Budget control | `recall_budget` + `recall_max_tokens` | `budget` + `maxTokens` via SDK |
| Retry on failure | Up to 3 attempts across turns | No retry on recall failure |

**What the differences mean:**

- **Recall modes.** `@walodayeet/hindsight-pi` lets you set `recallMode: tools` to skip auto-injection entirely. This eliminates the `before_agent_start` blocking cost, which matters if your Hindsight server is slow or remote. This extension always auto-injects on first turn, no way to disable without unloading the extension.
- **Dual-bank recall.** Both extensions query multiple banks. This extension always queries global + project banks in parallel on every first turn, so cross-project knowledge is always available. `@walodayeet/hindsight-pi` does the same when `globalBankId` is configured, plus supports linked banks for multi-server setups.
- **Injection frequency.** `@walodayeet/hindsight-pi` makes the `first-turn` vs `every-turn` choice explicit and prompt-cache-friendly. This extension does the same thing implicitly (the `recallDone` flag), but the behavior is identical in practice.
- **Retry logic.** This extension retries recall up to 3 times across turns if the server is temporarily unreachable, which helps with flaky connections. `@walodayeet/hindsight-pi` does not retry recall, but retries retain writes with a 1.5s backoff.

### Retain

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Trigger | `agent_end`, async by default | `agent_end` |
| Write scheduling | Immediate (async fire-and-forget) or sync | `turn`, `async`, `session`, or N-turn batch |
| Retain modes | Full transcript, append mode | `response`, `step-batch`, `both`, or `off` |
| Content retained | User + assistant + non-operational tool calls | User + assistant text (turn summary) |
| Document strategy | Append-mode with stable `document_id` per session | Per-turn writes, chunked if large |
| Credential sanitization | No | Yes (strips API keys, tokens, secrets) |
| Session lifecycle | Resets on `session_compact` | Flushes on shutdown, switch, compact, fork |

**What the differences mean:**

- **Write scheduling.** `@walodayeet/hindsight-pi` offers `session` (batch all writes until session end) and numeric batching (flush every N turns). This reduces server load for long sessions. This extension fires immediately after each turn, either async (non-blocking, default) or sync (blocks until confirmed).
- **Retain content.** This extension retains the full transcript including tool call names and inputs (excluding noisy operational tools like `bash`, `read`, `write`). This gives Hindsight richer context for extraction. `@walodayeet/hindsight-pi` retains a user+assistant text summary, which is lighter but may lose tool-use context.
- **Append mode.** This extension uses `document_id` + `update_mode: append`, so Hindsight only re-extracts the new delta each turn rather than reprocessing the entire session. `@walodayeet/hindsight-pi` writes each turn as separate retain calls, which is simpler but means each turn is processed independently.
- **Credential sanitization.** `@walodayeet/hindsight-pi` strips API keys, bearer tokens, and secrets from retained content before sending to the server. This extension does not, so secrets in conversation may end up in your Hindsight memory. If you work with credentials in chat, this matters.
- **Session lifecycle.** `@walodayeet/hindsight-pi` hooks into more Pi lifecycle events (shutdown, switch, fork) to flush pending writes. This extension only resets state on `session_compact`. If Pi exits abruptly with `session`-mode batching, `@walodayeet/hindsight-pi` is more likely to flush pending writes.

### Per-prompt controls

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Opt-out | `#nomem` or `#skip` to skip retain | Not available |
| Global bank routing | `#global` or `#me` per prompt | Configured at bank strategy level |
| Custom tags | `#hashtags` in prompt attached to memory | Automatic metadata tags (source, workspace, kind) |
| Trivial prompt skip | Yes | Yes, plus meta-memory query filtering |

**What the differences mean:**

- **Opt-out.** This extension lets you prevent any single turn from being retained by starting your prompt with `#nomem` or `#skip`. Useful for sensitive discussions, throwaway questions, or noisy debugging sessions. `@walodayeet/hindsight-pi` has no per-prompt opt-out; you would need to set `retainMode: off` in config.
- **Global bank routing.** This extension lets you tag individual prompts with `#global` or `#me` to also retain that turn to your global bank (cross-project learnings). `@walodayeet/hindsight-pi` routes to global bank based on the configured `bankStrategy`, not per-prompt.
- **Custom tags.** This extension extracts `#hashtags` from your prompt and attaches them as Hindsight tags, useful for filtering memories later. `@walodayeet/hindsight-pi` adds structured metadata tags automatically (source, workspace, bank, kind) but does not extract user-defined tags from prompts.

### Tooling and setup

| Dimension         | **pi-hindsight**                                            | **@walodayeet/hindsight-pi**                                                          |
| -------------------| -------------------------------------------------------------| ---------------------------------------------------------------------------------------|
| Config format     | `.ini` (`~/.hindsight/config`)                              | JSON (`~/.hindsight/config.json`), also reads `.toml`                                 |
| Config inspection | `/hindsight config` shows current values                    | `/hindsight:where` shows which file won precedence                                    |
| Setup experience  | Manual: edit config file, run `/hindsight status`           | Interactive: `/hindsight:setup` wizard                                                |
| Diagnostics       | `/hindsight status` (health + hooks + log tail)             | `/hindsight:doctor` (preflight), `/hindsight:status` (runtime)                        |
| Manual tools      | `hindsight_recall`, `hindsight_retain`, `hindsight_reflect` | `hindsight_search`, `hindsight_context`, `hindsight_retain`, `hindsight_bank_profile` |
| Commands          | 3 (`status`, `stats`, `config`)                             | 10+ (setup, settings, doctor, where, sync, map, mode, config, connect, stats)         |
| Performance docs  | Benchmarks, latency analysis, Supabase index guide          | Not included                                                                          |

**What the differences mean:**

- **Setup.** `@walodayeet/hindsight-pi` has an interactive setup wizard that walks you through enabling Hindsight, setting the URL, choosing bank strategy, and saving. This extension requires manually editing a config file. If you are comfortable with config files, this is fine. If you want a guided first run, theirs is smoother.
- **Diagnostics.** Both have status commands. `@walodayeet/hindsight-pi` adds `/hindsight:doctor` for preflight checks and `/hindsight:where` to show exactly which config file contributed each value. This extension shows hook state and debug log tail inline in `/hindsight status`.
- **Tools.** This extension includes `hindsight_reflect` for server-side memory synthesis (Hindsight reasons over your memories and returns a synthesized answer). `@walodayeet/hindsight-pi` includes `hindsight_context` (similar, backed by the reflect API) and `hindsight_bank_profile` for inspecting bank metadata.
- **Performance documentation.** This extension includes latency benchmarks, analysis of what causes slow recall, and a Supabase index checklist. Useful if you are tuning a self-hosted setup.

### Backend requirements

Both extensions require the same backend:
- A self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server
- Postgres with pgvector (Supabase works, dedicated Postgres works)
- An embedding API (Gemini `embedding-001` or compatible)
- HNSW indexes on `memory_units` for acceptable recall latency (see [Performance tuning](docs/performance.md))

Neither extension bundles or manages the backend. You deploy Hindsight separately and point the extension at it via config.

This extension uses raw `fetch` calls against the Hindsight REST API, no SDK dependency. `@walodayeet/hindsight-pi` uses the official `@vectorize-io/hindsight-client` SDK, which adds a dependency but tracks API changes automatically.

### When to choose this extension

- You want a single-file, low-overhead setup with minimal config.
- Per-prompt memory controls matter: `#nomem` to skip, `#global` to route, `#tags` to annotate.
- You prefer full transcript retention with append-mode documents over turn summaries.
- You want `hindsight_reflect` for server-side memory synthesis.
- You want documented performance benchmarks and Supabase index guidance.
- You prefer zero extra dependencies beyond Pi itself.

### When to choose @walodayeet/hindsight-pi

- You want granular recall control: `tools`-only mode eliminates cold-start latency from `before_agent_start` blocking.
- Flexible retain scheduling matters: `session`, `async`, or N-turn batching to reduce server load.
- You want a setup wizard and diagnostic commands (`/hindsight:doctor`, `/hindsight:where`).
- Credential sanitization in retained content is important to you.
- You prefer JSON config with a richer settings hierarchy.
- You want the official Hindsight client SDK for automatic API compatibility.

### Shared strengths

Both extensions:
- Auto-recall relevant memories before agent turns
- Auto-retain conversation after agent turns
- Query global + project banks for cross-project knowledge
- Show visible recall/retain indicators in chat
- Provide manual tools for explicit memory operations
- Skip trivial prompts to reduce noise
- Support project-level config overrides
- Work with any self-hosted Hindsight server

## Running tests

```bash
node --experimental-strip-types test.ts
```
