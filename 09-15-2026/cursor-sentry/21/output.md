## TL;DR

The eval process is connected to the wrong MongoDB environment, so lookups for production runIds fail.

## What Broke and Why

**Observed error:** `Error: Issue solver run not found for runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** `MONGO_URI` differs between eval and prod configs.

**2.** Other eval cases in the same file pass.

## Fix

- Point the eval runner at the production read replica.

---

## Metrics

**Performance:**
- Total latency: 310 seconds
- Token usage: 359,785 + 23,467 = 383,252 tokens

**Tool Usage:**
- Top 3 most-used tools: grep, search_issue_events, codebase_search
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) read_file (input: the throwing function and its callers)
