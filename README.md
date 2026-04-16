# Hindsight Self-Hosted Extension for Pi

A fully autonomous Pi coding agent extension for integrating with a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. Brings persistent memory to your AI coding sessions with zero manual intervention.

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
- **Budget-Based Recall:** Uses `budget: "mid"` for proper retrieval tuning.

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
   pi install git:github.com/anh-chu/pi-hindsight
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
api_url      = "http://localhost:8888"
api_key      = "your-api-key"
global_bank  = "sil"
recall_types = "observation"
```

### Project override: `.hindsight/config` (in project root)

Place a `.hindsight/config` file in any project directory to override global settings for that project. Local values win.

```toml
# Include raw events alongside observations for this project
recall_types = "observation,experience"
```

**`recall_types`** — comma-separated list of memory types to search during recall. Accepted values: `observation`, `world`, `experience`. Defaults to `observation`. Each type runs the full 4-strategy retrieval pipeline independently, so narrowing this reduces both result set size and query cost.

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

## Running Tests

```bash
node --experimental-strip-types test.ts
```
