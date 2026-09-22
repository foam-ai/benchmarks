## TL;DR

An unauthenticated user hit `/issues`; `getUser()` returned `null` for the missing session cookie, and the page dereferenced `user!.customerId` with a non-null assertion and no guard.

## What Broke and Why

**Observed error:** `TypeError: Cannot read properties of null (reading 'customerId')`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** The non-null assertion hides the nullable return type from the compiler.

**2.** Next.js suppresses the message in production, which is why the Sentry event is terse.

## Fix

- Redirect to login (or `notFound()`) when `getUser()` returns `null` and remove the `!`.

---

## Metrics

**Performance:**
- Total latency: 457 seconds
- Token usage: 466,127 + 15,679 = 481,806 tokens

**Tool Usage:**
- Top 3 most-used tools: codebase_search, read_file, list_dir
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) read_file (input: the throwing function and its callers) grep (input: the error string across the repo)
