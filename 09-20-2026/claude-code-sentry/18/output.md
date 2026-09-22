## TL;DR

Agent queries were missing timestamp filters and scanning the full `otel_logs` table while 20 agents ran in parallel, overloading ClickHouse memory.

## What Broke and Why

**Observed error:** `ClickHouse error: Memory limit (for query) exceeded`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** Several concurrent broad scans in the same minute.

**2.** No time bounds on the queries.

## Fix

- Require a timestamp predicate and limit agent concurrency.

---

## Metrics

**Performance:**
- Total latency: 462 seconds
- Token usage: 216,657 + 8,900 = 225,557 tokens

**Tool Usage:**
- Top 3 most-used tools: Read, Grep, get_sentry_resource
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
