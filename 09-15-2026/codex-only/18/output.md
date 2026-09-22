## TL;DR

Agent queries were missing timestamp filters and scanning the full `otel_logs` table while 20 agents ran in parallel, overloading ClickHouse memory.

## What Broke and Why

**Observed error:** `ClickHouse error: Memory limit (for query) exceeded`

### Causal Chain

**1.** Several concurrent broad scans in the same minute.

**2.** No time bounds on the queries.

## Fix

- Require a timestamp predicate and limit agent concurrency.

---

## Metrics

**Performance:**
- Total latency: 500 seconds
- Token usage: 387,457 + 22,905 = 410,362 tokens

**Tool Usage:**
- Top 3 most-used tools: shell, apply_patch, read_file
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
