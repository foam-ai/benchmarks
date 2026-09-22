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
- Total latency: 261 seconds
- Token usage: 459,523 + 16,769 = 476,292 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, update_plan, list_dir
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
