# Hindsight Self-Hosted Extension for Pi

A fully autonomous Pi coding agent extension for integrating with a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. Brings persistent memory to your AI coding sessions with zero manual intervention.

Recommended for most users running Hindsight in production, use self-hosted Hindsight for full data control and stable memory quality.

## Install

### Recommended

```bash
pi install npm:pi-hindsight
```

### Git fallback

```bash
pi install git:github.com/anh-chu/pi-hindsight
```

## Why Hindsight + this extension

Quick take, this pairing helps memory stay useful without extra routine work.
- **Graph and relationship aware retrieval:** Hindsight retrieval can use semantic, BM25, graph, and temporal strategies, so linked facts are easier to recover.
- **Entity-aware memory:** people, projects, tools, and artifacts can be recalled as connected context instead of isolated snippets.
- **Freshness-aware recall:** requests include `query_timestamp`, helping recent context rank higher when it matters.
- **Project + global memory cooperation:** project bank handles local work history, optional global bank carries cross-project patterns.
- **Visible and debuggable:** memory recall/retain events show in chat, manual tools exist when you want explicit control.
- **Zero-latency retention:** memory is written asynchronously by default — retain fires at turn end without blocking your next prompt. Append-mode updates process only the new delta, so there's no redundant reprocessing either.

## How this compares to common agent memory patterns

| Approach | Typical tradeoff | Hindsight + this extension |
|---|---|---|
| Markdown/file-based memory notes | Human-readable, but memory quality desaturates over time | Automatic retain + retrieval, still inspectable via banks/tools |
| ChromaDB-style custom memory stack | Flexible, but requires ongoing schema/retrieval tuning | Built-in memory model + multi-strategy recall pipeline |
| `pi-memex` style extension memory | Weak de-duplication, limited project/global cooperation | Observation-first recall with deduplication and project/global bank cooperation |
| `pi-hippo-memory` style extension memory | Good bio-retention behavior, but old memories may be dropped based on policy | Explicit retain/recall hooks with tags, recall type controls, and bank-level persistence |

If you need long-lived, inspectable memory for coding agents, this setup is practical default.

## Features

### Automatic Memory Lifecycle

- **Auto-Recall:** Before each agent turn, queries the project bank and injects relevant memories directly into the prompt. Zero agent action needed.
- **Auto-Retain:** After each agent turn, appends the conversation transcript to a per-session document (`update_mode: append`) using a stable `document_id`. Hindsight only re-extracts the new delta — no redundant LLM calls.
- **Feedback Loop Prevention:** Strips `<hindsight_memories>` blocks from the transcript before retain. Prevents recursive memory bloat.
- **Operational Tool Filtering:** Drops low-signal tools (bash, read, write, edit, etc.) from the retained transcript. Keeps conversation and non-trivial tool calls only.

### Memory Quality

- **Observation-Focused Recall:** Defaults to `observation` type only — consolidated, deduplicated beliefs synthesized from multiple memories. Highest signal, lowest noise. Configurable per-project.
- **Rich Retain Context:** Each retain includes `context` (derived from the user's prompt), `timestamp`, `document_id`, and `update_mode: append` for best extraction quality.
- **Temporal Recall:** Recall requests include `query_timestamp` so Hindsight can rank memories by recency.
- **Budget-Based Recall:** Uses `budget: "mid"` by default, configurable via `recall_budget`. Token budget for injected memories is configurable via `recall_max_tokens` (server default: 4096).

### Opt-In / Opt-Out Controls

- `#nomem` or `#skip` at the start of a prompt — skip retain for that turn.
- `#global` or `#me` anywhere in a prompt — also retain to your `global_bank` (cross-project learnings).
- Custom hashtags (e.g. `#architecture`, `#bug`) — extracted and attached as Hindsight tags for filtering.

### In-Chat Visibility

Every memory event is visible in the Pi chat:

| Event | Display |
|-------|---------|
| Recall | `🧠 Hindsight recalled N memories` + snippet |
| Retain (success) | `💾 Hindsight saved turn to memory → bank-name` |
| Retain (failure) | `💾 Hindsight retain failed — use hindsight_retain to save manually` |

### Manual Tools

Two tools available for explicit memory management:

- `hindsight_recall` — Manually pull additional context from memory
- `hindsight_retain` — Force-save a specific insight

## Setup

1. Install this extension:
   ```bash
   pi install npm:pi-hindsight
   ```

2. Configure your Hindsight server credentials in `~/.hindsight/config`:
   ```toml
   api_url = "http://your-hindsight-server:8888"
   api_key = "<API_KEY>"
   global_bank = "optional-global-bank-id"
   ```

3. Run `/hindsight status` in Pi to verify everything is working.

No further setup needed — memory is fully automatic from the first session.

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

Place a `.hindsight/config` file in any project directory to override global settings for that project. Local values win.

```toml
# Include raw events alongside observations for this project
recall_types     = "observation,experience"
recall_budget   = "low"
recall_max_tokens = 512
```

**`recall_types`** — comma-separated list of memory types to search during recall. Accepted values: `observation`, `world`, `experience`. Defaults to `observation`. Each type runs the full 4-strategy retrieval pipeline independently, so narrowing this reduces both result set size and query cost.

**`recall_budget`** — controls retrieval depth and breadth. Accepted: `low`, `mid`, `high`. Defaults to `mid`. Use `low` for faster, cheaper lookups with less noise. `high` increases coverage but adds latency and instability (see performance benchmarks).

**`recall_max_tokens`** — maximum tokens the returned memories can occupy. Unset by default (server uses 4096). Lower values reduce context injection noise with no latency impact. Recommended: `800` for everyday use.

**`async_retain`** — controls whether memory retention blocks the end of a turn. Defaults to `true` (non-blocking). Set to `false` to retain synchronously — enables retain failure notifications and `/hindsight status` retain tracking, at the cost of added turn latency.

## Commands

### `/hindsight status`
Full health check for the current session:
- Server reachability
- Auth validity
- Project bank accessibility
- Hook execution state (session_start, recall, retain)
- Debug log tail (when `HINDSIGHT_DEBUG=1`)

Example output:
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
Shows memory/entity/document counts for all active banks.

## Debug Logging

Set `HINDSIGHT_DEBUG=1` to enable verbose logging to `~/.hindsight/debug.log`. Log tail is shown inline in `/hindsight status`.

## Banks

- **Project bank** (`project-<dirname>`) — auto-created per working directory. All turns are retained here by default.
- **Global bank** — optional, configured via `global_bank` in `~/.hindsight/config`. Receives turns tagged `#global` or `#me`.

## Performance

### Recall latency benchmarks

Tested against a self-hosted Hindsight server (2 vCPU / 8 GB RAM) backed by Supabase free tier (shared CPU, pgvector). Pi queries two banks in parallel on every first prompt — one global bank and one project bank.

**Setup:**
- Hindsight server: 2 vCPU / 8 GB RAM, local network (~50ms RTT)
- Database: Supabase free tier, session pooler mode
- Embedding: Gemini `embedding-001` (remote API)
- Banks: 68 memory units (global), 182 memory units (project)
- Query pattern: 2 parallel recall requests (global + project bank)

**Results after HNSW index on `memory_units`:**

| budget | max_tokens | avg wall time | notes |
|---|---|---|---|
| `mid` | `512` | ~3.97s | most consistent |
| `mid` | `1024` | ~4.02s | fine |
| `mid` | `4096` | ~3.98s | returns all memories |
| `high` | `512` | ~7.42s | unstable, spiked to 18s |
| `high` | `1024` | ~4.00s | no benefit over mid |
| `high` | `4096` | ~4.03s | no benefit over mid |

**Recommended settings:**

```toml
# ~/.hindsight/config
recall_budget     = mid   # high adds instability with no latency benefit
recall_max_tokens = 512   # reduces context injection noise; no latency impact
```

### What causes recall latency

In order of impact:

1. **Missing HNSW index on `memory_units`** — the biggest factor. Without it, every recall is a full sequential cosine scan across all rows. Add partial HNSW indexes per `bank_id` + `fact_type`:
   ```sql
   -- example for one bank+type combination
   CREATE INDEX ON memory_units USING hnsw (embedding vector_cosine_ops)
     WHERE fact_type = 'observation' AND bank_id = 'your-bank';
   ```
   The Hindsight server auto-creates these via `/codesight-init` or the onboarding flow. If missing, create them manually per bank per fact type.

2. **Supabase free tier CPU** — shared, severely throttled. Even with HNSW, expect 3–5s per parallel pair. Concurrent pgvector queries compete for CPU. Upgrading to a paid tier drops this significantly.

3. **Gemini embedding API latency** — ~0.5–1s fixed cost per recall request, unavoidable.

4. **Parallel vs sequential queries** — Pi queries both banks in parallel. Pre-index, this caused severe contention (17–36s). Post-index, parallel is faster than sequential (~4s wall vs ~6s sequential) because Supabase can handle two HNSW queries concurrently once the index is in place.

5. **`max_tokens` does not affect latency** — the server does the same work regardless of how many results it returns. Lower `max_tokens` only reduces context injection size.

### Supabase index checklist

Run in Supabase SQL editor to verify your setup:

```sql
-- confirm HNSW indexes exist on memory_units
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'memory_units' AND indexdef LIKE '%hnsw%';

-- confirm no full-table HNSW (redundant, wastes storage)
-- drop if present:
-- DROP INDEX idx_memory_units_embedding_hnsw;

-- confirm chunks FK indexes exist
SELECT indexname FROM pg_indexes
WHERE tablename = 'chunks';
-- should include idx_chunks_bank_id and idx_chunks_document_id
```

## Running Tests

```bash
node --experimental-strip-types test.ts
```
