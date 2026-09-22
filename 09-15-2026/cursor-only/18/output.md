## TL;DR

A broad agent query — a join between `otel_logs` and `otel_traces` without a selective key — exhausted ClickHouse memory; `queryOtel` imposes no memory limit, and parallel agents made it worse.

## What Broke and Why

**Observed error:** `ClickHouse error: Memory limit (for query) exceeded`

### Causal Chain

**1.** The join key is coarse.

**2.** No memory budget on the tool.

## Fix

- Add a per-query memory limit and tighten query validation.

---

## Metrics

**Performance:**
- Total latency: 266 seconds
- Token usage: 226,981 + 23,238 = 250,219 tokens

**Tool Usage:**
- Top 3 most-used tools: list_dir, run_terminal_cmd, read_file
- Top 3 most USEFUL tools: read_file (input: the throwing function and its callers) grep (input: the error string across the repo) codebase_search (input: where the failing code path is invoked)
