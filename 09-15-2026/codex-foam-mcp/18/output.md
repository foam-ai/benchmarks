## TL;DR

A broad agent query — a join between `otel_logs` and `otel_traces` without a selective key — exhausted ClickHouse memory; `queryOtel` imposes no memory limit, and parallel agents made it worse.

## What Broke and Why

**Observed error:** `ClickHouse error: Memory limit (for query) exceeded`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** The join key is coarse.

**2.** No memory budget on the tool.

## Fix

- Add a per-query memory limit and tighten query validation.

---

## Metrics

**Performance:**
- Total latency: 327 seconds
- Token usage: 488,078 + 7,646 = 495,724 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, list_dir, update_plan
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
