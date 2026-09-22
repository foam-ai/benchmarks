## TL;DR

A race in webhook deduplication allows two workers to process the same Sentry event; the lock insert is not idempotent and one request fails hard.

## What Broke and Why

**Observed error:** `MongoServerError: E11000 duplicate key error collection: locks index: resource_1`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** Two requests with the same resource ID arrive within 40ms.

**2.** The second request's error is surfaced to the caller as a 500.

## Fix

- Use an idempotency key derived from the Sentry event ID and upsert the lock document.

---

## Metrics

**Performance:**
- Total latency: 511 seconds
- Token usage: 552,755 + 19,584 = 572,339 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, query-otel, update_plan
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
