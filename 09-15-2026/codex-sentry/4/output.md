## TL;DR

`SimpletonAgent` hallucinated an invalid ClickHouse statement; the system prompt does not constrain the SQL dialect tightly enough.

## What Broke and Why

**Observed error:** `ClickHouse error: Syntax error: failed at position ... LIMIT 500 FORMAT JSONEachRow`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The failing query contains a trailing `LIMIT` clause on a `DESCRIBE`, which is invalid in ClickHouse.

**2.** The agent has no schema examples in its prompt.

## Fix

- Add dialect guidance and a `DESCRIBE` example to the agent prompt.

---

## Metrics

**Performance:**
- Total latency: 519 seconds
- Token usage: 372,797 + 19,940 = 392,737 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, search_issue_events, get_sentry_resource
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
