# Performance Tuning

## Recall latency benchmarks

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

## What causes recall latency

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

## Supabase index checklist

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
