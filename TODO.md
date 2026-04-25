# TODO

## Comparison with walodayeet/hindsight-pi

### Ours

- Recall: `before_agent_start`, blocking, no timeout
- Retain: `agent_end`, async with `Promise.allSettled`
- Tools: `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`
- Commands: `/hindsight [status|stats|config]`
- Config: `.ini` format (`~/.hindsight/config`)
- Bank strategy: global + `project-X` always
- Retain skips trivial prompts; `#nomem`/`#skip` opt-out; `#global`/`#me` opt into global bank retention
- Full transcript retain (user + assistant + tool calls) with `document_id` + `update_mode: append`

### Theirs (walodayeet/hindsight-pi)

- Recall modes: `hybrid`, `context`, `tools`, `off`
- Recall types: `observation`, `experience`, `world`; configurable per-type count
- Display: `grouped` or `unified`; injection frequency `first-turn` or `every-turn`
- Retain modes: `response`, `step-batch`, `both`, `off`
- Write frequencies: `turn`, `async`, `session`, or numeric batch
- Bank strategies: `manual`, `per-repo`
- Config: JSON with full global + project hierarchy
- Commands: setup wizard, status, doctor, where, settings, sync, map, mode, config, connect, stats
- Tools: `hindsight_search`, `hindsight_context`, `hindsight_retain`, `hindsight_bank_profile`

### They do better

- **`injectionFrequency: first-turn`** — explicit, prompt-cache-friendly (we do this implicitly via `recallDone` flag, same effect but less clear)
- **`recallMode: tools`** — skips auto-injection entirely, recall only via explicit tool call. Eliminates the `before_agent_start` block — fixes cold-start latency
- **`retain write frequencies`** — `async`, `session`, `N-turn batch`. We always fire synchronously at `agent_end` → steal this
- **`/hindsight:where`** — shows which config file won precedence
- **`/hindsight:setup`** wizard, **`/hindsight:doctor`** preflight
- **`hindsight_bank_profile`** tool

### We do better

- **`#nomem`/`#skip` opt-out** — they don't have this
- **`#global`/`#me` retain opt-in** — per-prompt bank routing, they don't have this
- **Custom tag extraction** — `#tags` in prompt get passed to Hindsight memory items
- **Trivial prompt skip** — doesn't retain "ok", "yes", "thanks" etc.
- **Full transcript retain** — builds user+assistant+tool transcript, not just response summary; uses `document_id` + `update_mode: append` for session continuity
