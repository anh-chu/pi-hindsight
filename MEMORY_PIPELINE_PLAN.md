# Memory Pipeline Parity Plan (pi extension)

Adopt the semantics we just shipped in `opencode-hindsight` v0.4.0
(MEMORY_PIPELINE_PLAN.md there) into the pi extension, mapped onto pi's
extension API — **without** importing the opencode plugin's modular
architecture. This extension's differentiator is a single-file, zero-dep
install; we port the *behavior*, not the file layout.

Status: PLAN (not yet started). Companion: README.md, TODO.md.

---

## 1. The good news: pi is already halfway there

The opencode plan existed because that plugin had four structural problems.
pi-hindsight only has one and a half of them. Mapping each opencode
workstream to what pi does today:

| opencode WS | Mechanic | pi-hindsight today | Verdict |
|---|---|---|---|
| 1 | Prefix-cache-safe injection channel | `before_agent_start` returns `{ message: { customType: "hindsight-recall", ... } }` — a **stored, model-facing session message**; the system prompt is never touched | ✅ **Already solved.** Pi's returned message is the moral equivalent of opencode's synthetic message: paid once as a cache write, byte-stable thereafter. Nothing to do |
| 2 | Once-per-session cadence | `recallDone` flag: one recall per session, re-armed after compaction | 🟡 Cadence is right; missing the tri-state engine, reflect source, and core-memory freeze |
| 3 | Prompt hygiene + query bounding | `stripAllMemoryBlocks` on retain only; the **raw prompt** is the recall query with no token bound | ❌ Port both |
| 4 | Write-back: refetch, growth gate, bank isolation | Buffered gated retain at `agent_end`, flush on shutdown/compact, append-mode doc per session | 🟡 Refetch + `ownSessions` are **N/A in pi** (agent_end messages are complete; one extension instance per session, no cross-project event bus). Retried runs can double-count turns — port a light growth fingerprint |
| 5 | Reflect fallback chain | `hindsight_reflect` tool exists (v1.2.0 path) but auto-inject never uses reflect | ❌ Port |
| 6 | Compaction hook | Flushes pending turns on `session_compact`, then re-arms recall | ✅ **Keep — better than opencode's mapping.** Post-compaction recall gives the wiped context fresh memory; opencode can't do this. No change |
| 7 | Diagnostics + benchmark | `HINDSIGHT_DEBUG=1` text log, `/hindsight status` hook stats | 🟡 Optional JSONL diag; benchmark script worth porting |

So the real work is: **WS2/WS5 (reflect-first injection engine), WS3
(hygiene + bounding), WS4-lite (growth fingerprint), WS7 (ops)**.

### Why reflect-first matters here

Today's auto-recall injects a raw retrieval list against the first prompt.
The official coding-agents plugin — and now our opencode fork — injects a
**server-side synthesis** (`POST /v1/default/banks/{bank}/reflect`) built for
the session's goal. It is denser (one coherent answer vs N loose snippets),
budget-aware, and is the single biggest quality parity gap. The reflect
endpoint is already proven in this codebase (the `hindsight_reflect` tool,
fixed for the 1.2.0 path move in 0144df1).

---

## 2. Design principles (carried over)

1. **Never touch the system prompt.** (Already true; keep it true — the
   injection is always the `before_agent_start` returned message.)
2. **Inject once, pull on demand.** One synthesis per session; the three
   tools are the pull channel.
3. **Failures are retryable, empties are answers.** Tri-state, attempt
   budgets, permanent 4xx resolves immediately.
4. **Fail open.** Hindsight down ⇒ plain pi, one status-line note.
5. **One-line install, one config file.** No new required keys; everything
   defaults correctly. Single file stays single file.

---

## 3. Workstreams

### WS-P1 — InjectionEngine (tri-state, reflect-first, core freeze) — the core work ✅ (Phase 1)

Add an engine section to `index.ts` (module-level inside the extension
closure), state machine ported from `opencode-hindsight/src/inject/engine.ts`:

```ts
type InjectState =
  | { status: "unresolved"; attempts: number }
  | { status: "empty"; attempts: number }
  | { status: "answer"; text: string };
```

- **Modes** — `auto_inject: "reflect" | "recall" | "per_message" | "none"`,
  default `"reflect"`:
  - `reflect`: one `POST .../reflect` per session, first substantive prompt
    as the goal, `budget: "low"`-shaped request, `reflect_timeout_ms`.
  - `recall`: today's behavior through the same engine (one recall/session).
  - `per_message`: recall every user turn (engine bypassed; the escape hatch
    opencode also keeps).
  - `none`: tools only.
- **Tri-state + budgets** — failure consumes one of `inject_failure_attempts`
  (default 2; replaces the flat `MAX_RECALL_ATTEMPTS = 3`), empty consumes one
  of `inject_empty_attempts` (default 5). Permanent 4xx (except 429, which
  already has its own backoff path) ⇒ resolve `empty` immediately. Auth
  failure keeps today's give-up-immediately behavior.
- **Trivial-prompt skip** — prompts shorter than `min_reflect_prompt_chars`
  (default 8) don't consume an attempt; a "hi" opener must not burn the
  session's synthesis. (The trivial-prompt list already in `isTrivialPrompt`
  is reused for this check on the recall path.)
- **Cold-bank defer** — optional v1.1: cheap probe recall; if the bank is
  empty, turn 1 skips without consuming an attempt.
- **Inject exactly once** — the answer rides the turn it ran on
  (`ranThisTurn`), never re-injected. Unchanged from opencode WS2.
- **Core-memory freeze** — port the `core` tag convention: recall with
  `tags: ["core"]`, `types: ["world"]`, fixed query, capped at
  `core_memory_max_tokens` (default 256). Formatted once, byte-frozen for the
  session, rendered as the head section of the injected block. On pi this is
  fetched lazily inside the first `before_agent_start` (no session-start
  prefetch exists; add one fire-and-forget like today's warm-up ping if the
  latency shows up).
- **Compaction re-arm stays** — `session_compact` resets the engine (fresh
  synthesis for the wiped context). This is intentional and better than the
  opencode mapping; document it as such.

**Block format v2** (same `<hindsight_memories>` wrapper so
`stripAllMemoryBlocks` keeps protecting retention):

```
<hindsight_memories>
[core] Stable preferences/conventions …           ← frozen section (optional)
[context] Synthesis for "<goal excerpt>" …        ← reflect body, once per session
(memory tools are available for deeper lookups: hindsight_recall / hindsight_reflect)
</hindsight_memories>
```

The `[Bank: x] - ` per-result prefixes stay only on the `recall`/
`per_message` paths and tool output, not on the reflect block.

**Multi-bank decision.** pi recalls from project + global banks in parallel;
reflect is per-bank. Proposal: reflect on the **project bank** (the session's
primary), and in parallel run the existing recall against the global bank,
appending a trimmed `[global]` section when it has hits. Reflecting both and
merging syntheses doubles latency and cost for marginal gain. Flagged as open
decision §8.1.

**Delivery.** Unchanged: `before_agent_start` returns the message once.
The `hindsight-recall` message renderer, status line, and hook stats keep
working; add the mode to the `/hindsight status` output.

*Shipped:* `createInjectionEngine` in index.ts with tri-state + budgets,
trivial skip, permanent-4xx immediate resolve, core freeze (`tags: ["core"]`,
`types: ["world"]`, fetched once, byte-frozen, prefixed `[core]`), the
multi-bank decision as proposed (project reflect + parallel global recall →
`[global]` section, capped at 5 hits / 256 tokens), the reflect→recall
fallback chain, and the block-v2 format. Compaction re-arm kept. pi-specific
adaptation: delivery happens exactly once, on the turn the answer arrived
(pi messages are stored — re-emitting would duplicate); opencode's
re-emit-per-model-call has no pi equivalent. Open decision §8.1 resolved as
proposed; §8.3 (cold-bank defer) deferred — not in Phase 1.

### WS-P2 — Reflect fallback chain (shared deadline) ✅ (Phase 2)

On a *retryable* reflect failure (timeout, 5xx, network), run
`recall()` with the bounded query (WS-P3) under a shared
`inject_timeout_ms` (default 8s) deadline counted from fallback start —
port of WS5 without the pages-API stretch goal. A fallback body is cached
exactly like an answer. Permanent 4xx skips reflect retries but still gets
one fallback recall. Both reflect and fallback recall get per-call
`AbortController` timeouts (the plumbing `hindsight_reflect` already has).

*Shipped:* the chain itself landed with Phase 1 as a preview; Phase 2 added
the dedicated `inject_timeout_ms` budget (distinct from `recall_timeout`)
governing both the fallback recall and the global-bank side recall,
`via: "fallback"` provenance on the answer state, and tests for
deadline-abort → failure-attempt consumption, empty-fallback +
permanent-4xx immediate resolve, and provenance wiring.

### WS-P3 — Prompt hygiene and query bounding ✅ (Phase 0)

Port `content.ts` helpers into `index.ts`:

1. `stripInjectedMemory(text)` — superset of the current
   `stripAllMemoryBlocks`: also strips `<system-reminder>…</system-reminder>`
   and `<context key="…">…</context>` wrappers before any text becomes a
   reflect goal, recall query, or retained content. Applied on the recall
   query path, the reflect goal, and `sanitizeTranscript`.
2. `boundQueryTokens(text, max = 500)` — byte-aware estimator (ASCII ≈
   0.5 token/char, non-ASCII charged by UTF-8 byte length). Old servers 400
   on recall queries over 500 tokens; today a long first prompt can silently
   cost the session its memory. `max_recall_query_tokens` config (default
   500). Budget *trimming* of results keeps the existing chars/4 estimator —
   it's a cap, not a bill.

*Shipped:* both helpers exported for tests; wired into auto-recall (with a
fallback to the generic probe query when the prompt strips to empty), both
`hindsight_recall` and `hindsight_reflect` tool queries (empty-after-strip is
an error, not a wasted call), and `sanitizeTranscript`. 19 tests in
`__tests__/query-hygiene.test.ts` (pure-function byte math incl. surrogate
pairs, wiring assertions on the wire payloads, retention hygiene).

### WS-P4 — Write-back growth fingerprint (light WS4) ✅ (Phase 3)

`agent_end` fires per low-level run; a retried or queued-message run can
re-count a logical turn and double-retain. Add a session-scoped fingerprint
(`"<lastUserPrompt-hash>:<assistant-content-hash>"` over the run's messages):
a run whose user prompt and assistant content hash to something already
buffered/retained is skipped. Keeps the existing gate/flush machinery
untouched. No refetch, no `ownSessions` — both are structurally N/A in pi.

*Shipped:* `fingerprintTurn(prompt, transcript)` (djb2, exported) computed
over the exact retained bytes; identical re-fired `agent_end` signals are
skipped before buffering; genuine regeneration (same prompt, new content)
stills buffers; the fingerprint resets on `session_start` and
`session_compact` so post-compact turns are new logical turns. The N-turn
gate is unaffected (dedupe runs before gate counting). Tests in
`__tests__/growth-fingerprint.test.ts`.

### WS-P5 — Diagnostics + benchmark (ops) ✅ (Phase 4)

- Optional JSONL diag at `~/.hindsight/diagnostics.log`
  (`HINDSIGHT_DIAG_FILE` override, ~1MB rotate): `inject_ok/empty/failed`,
  `reflect_ok/failed/deferred`, `recall_*`, `retain_ok/failed`. Surface
  last-24h counters in `/hindsight status`.
- `scripts/benchmark-session.mjs`-style harness (or a vitest case) driving
  the extension's hooks against a fake Hindsight server: 20-turn session
  asserting **≤ 3 API calls, exactly 1 injected message, and no system-prompt
  mutation** (the pi-native equivalent of the constant-hash assertion: the
  handler must never return `systemPrompt`). Run in `npm test`.

*Shipped:* `diag()` ported from opencode (sync-FS pi variant: JSONL, rotate
at 1MB, field clipping, `HINDSIGHT_DIAG=0` off-switch, never throws) wired
into every inject/reflect-fallback/core/retain outcome; last-24h per-event
counters in `/hindsight status` (tail-read of the last 512KB);
`__tests__/benchmark-session.test.ts` runs a 20-turn session per mode and
asserts the structural invariants (reflect: ≤3 injection-side calls, exactly
1 injection, never `systemPrompt`; per_message: 20 recalls/20 injections as
the documented escape hatch; recall: 2 calls, 1 injection).
`__tests__/diag.test.ts` covers rotation/off-switch/sanitization.

---

## 4. Configuration changes

| Key | Default | Notes |
|---|---|---|
| `auto_inject` | `"reflect"` | `reflect` \| `recall` \| `per_message` \| `none`. Migration: `recall_enabled = false` ⇒ `none`; unset ⇒ `reflect` (**behavior change** — today is effectively `recall`) |
| `reflect_timeout_ms` | `20000` | auto-inject reflect only; the `hindsight_reflect` tool stays unbounded |
| `inject_timeout_ms` | `8000` | shared fallback-chain budget |
| `inject_failure_attempts` | `2` | replaces hardcoded `MAX_RECALL_ATTEMPTS = 3` |
| `inject_empty_attempts` | `5` | |
| `min_reflect_prompt_chars` | `8` | skip without consuming an attempt |
| `max_recall_query_tokens` | `500` | byte-aware bound on all recall queries |
| `core_memory_max_tokens` | `256` | frozen core section cap |

Removed: nothing. The settings menu gains `auto_inject`.

## 5. Implementation phases

Each phase ships green.

| Phase | Contents | Behavior change |
|---|---|---|
| **0** ✅ | WS-P3 hygiene + bounding (pure hardening) | none |
| **1** ✅ | WS-P1 engine (tri-state, budgets, trivial skip, core freeze, block v2, modes + migration) via the existing message channel | default becomes reflect-first; recall users set `auto_inject = "recall"` |
| **2** ✅ | WS-P2 fallback chain + per-call timeouts | reflect failures degrade to recall instead of nothing |
| **3** ✅ | WS-P4 growth fingerprint | retried runs no longer double-retain |
| **4** ✅ | WS-P5 diag/benchmark, README migration notes, release 1.7.0 | none (ops) |

Phases 1+2 could land as one PR if review prefers; kept separate to mirror
the opencode sequencing.

## 6. Testing plan

- **Unit (test.ts mock harness)**: tri-state resolution, both budgets,
  permanent-4xx immediate resolve, trivial skip, block formatting stability
  (same inputs ⇒ byte-identical block), `boundQueryTokens` byte math
  (ASCII/CJK/emoji), `stripInjectedMemory` wrapper cases, growth fingerprint
  dedupe.
- **Structural (20-turn fake server)**: total API calls ≤ 3; exactly one
  injected `hindsight-recall` message; **no handler ever returns
  `systemPrompt`**; compaction re-arm produces exactly one more synthesis;
  `per_message` mode preserves today's call count.
- **Manual E2E**: live pi session against real Hindsight — reflect answer
  grounded in retained facts; `/reload` mid-session re-synthesizes once
  (accepted cost, see risks); subagent child still disabled.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| First-turn reflect latency blocks the run (up to 20s) | Same tradeoff as today's blocking recall (10s default); budget shaping, trivial-prompt skip, failure budget caps at 2 × timeout per session; `recall` mode is the escape hatch |
| Reflect endpoint quality/version drift on self-hosted servers | Fallback chain (WS-P2); tool already handles the 1.2.0 path move; capability is server-version-agnostic since it's plain REST |
| Inject state is in-memory only — `/reload` or restart re-synthesizes | Accepted for v1 (idempotent-ish; costs one reflect). Optional later: persist via `pi.appendEntry` state entries |
| Global-bank memories lose the reflect treatment under the project-only proposal | Global bank still covered by the parallel recall section + `hindsight_recall`/`hindsight_reflect` tools; revisit if quality regresses (§8.1) |
| Users depending on per-session raw recall lists | `auto_inject = "recall"`; README migration note; minor-version bump |

## 8. Open decisions

1. **Multi-bank reflect**: project-reflect + global-recall merge (proposed)
   vs reflect-both-and-merge vs global-recall-only-when-reflect-empty.
2. **`inject_failure_attempts` default**: 2 (official parity) vs keep today's
   3. Propose 2; note in migration.
3. **Cold-bank defer**: include in Phase 1 or defer to a follow-up (it needs
   a probe call pi doesn't currently make). *Deferred — not shipped in the
   1.7.0 round; the core-freeze probe partially covers the intent.*
4. **Diag JSONL**: include now or keep the text debug log until there's a
   debugging need. *Shipped in Phase 4.*
