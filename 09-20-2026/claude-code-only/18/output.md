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
- Total latency: 409 seconds
- Token usage: 174,226 + 23,803 = 198,029 tokens

**Tool Usage:**
- Top 3 most-used tools: Grep, Bash, Read
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
