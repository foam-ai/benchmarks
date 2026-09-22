## TL;DR

A race in webhook deduplication allows two workers to process the same Sentry event; the lock insert is not idempotent and one request fails hard.

## What Broke and Why

**Observed error:** `MongoServerError: E11000 duplicate key error collection: locks index: resource_1`

### Causal Chain

**1.** Two requests with the same resource ID arrive within 40ms.

**2.** The second request's error is surfaced to the caller as a 500.

## Fix

- Use an idempotency key derived from the Sentry event ID and upsert the lock document.

---

## Metrics

**Performance:**
- Total latency: 382 seconds
- Token usage: 337,188 + 15,855 = 353,043 tokens

**Tool Usage:**
- Top 3 most-used tools: update_plan, read_file, shell
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
