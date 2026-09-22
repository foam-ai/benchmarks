## TL;DR

A race in webhook deduplication allows two workers to process the same Sentry event; the lock insert is not idempotent and one request fails hard.

## What Broke and Why

**Observed error:** `MongoServerError: E11000 duplicate key error collection: locks index: resource_1`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** Two requests with the same resource ID arrive within 40ms.

**2.** The second request's error is surfaced to the caller as a 500.

## Fix

- Use an idempotency key derived from the Sentry event ID and upsert the lock document.

---

## Metrics

**Performance:**
- Total latency: 492 seconds
- Token usage: 418,406 + 21,056 = 439,462 tokens

**Tool Usage:**
- Top 3 most-used tools: Read, Glob, get_sentry_resource
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
