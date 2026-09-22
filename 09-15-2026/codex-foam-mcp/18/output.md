## TL;DR

An agent generated a `FULL OUTER JOIN` between `otel_logs` and `otel_traces` on `DATE(Timestamp)`, producing a per-day cross-product that exhausted memory. `queryOtel` has no per-query memory budget and its validation is syntax-only, so the query ran.

## What Broke and Why

**Observed error:** `ClickHouse error: Memory limit (for query) exceeded`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** Joining on a low-cardinality date key multiplies rows per day.

**2.** Twenty parallel agents amplified the blast radius, but this specific join is what OOMed.

## Fix

- Set `max_memory_usage`/`max_execution_time` per query in `queryOtel` and reject joins without a selective key.

---

## Metrics

**Performance:**
- Total latency: 327 seconds
- Token usage: 488,078 + 7,646 = 495,724 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, list_dir, update_plan
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
