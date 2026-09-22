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
- Total latency: 386 seconds
- Token usage: 435,688 + 12,927 = 448,615 tokens

**Tool Usage:**
- Top 3 most-used tools: Read, Glob, Bash
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
