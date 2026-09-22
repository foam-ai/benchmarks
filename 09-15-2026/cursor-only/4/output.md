## TL;DR

`SimpletonAgent` hallucinated an invalid ClickHouse statement; the system prompt does not constrain the SQL dialect tightly enough.

## What Broke and Why

**Observed error:** `ClickHouse error: Syntax error: failed at position ... LIMIT 500 FORMAT JSONEachRow`

### Causal Chain

**1.** The failing query contains a trailing `LIMIT` clause on a `DESCRIBE`, which is invalid in ClickHouse.

**2.** The agent has no schema examples in its prompt.

## Fix

- Add dialect guidance and a `DESCRIBE` example to the agent prompt.

---

## Metrics

**Performance:**
- Total latency: 354 seconds
- Token usage: 513,714 + 13,978 = 527,692 tokens

**Tool Usage:**
- Top 3 most-used tools: list_dir, grep, read_file
- Top 3 most USEFUL tools: read_file (input: the throwing function and its callers) grep (input: the error string across the repo) codebase_search (input: where the failing code path is invoked)
