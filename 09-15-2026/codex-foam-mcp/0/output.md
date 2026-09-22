## TL;DR

The `porygon` issue page throws on an empty `solution` string returned by the backend; the page component is missing a null/empty guard for runs whose S3 object is empty.

## What Broke and Why

**Observed error:** `Error: Solution is empty (porygon/app/issues/[id]/page.tsx)`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** `page.tsx` reads `data.solution` and throws if it is falsy.

**2.** The S3 object for the run exists but is zero bytes, which the backend passes through verbatim.

**3.** Older runs from before the solver refactor also have empty objects, so the page crashes for them too.

## Fix

- Render an 'awaiting solution' state instead of throwing on an empty string.
- Backfill empty S3 objects for affected runs.

---

## Metrics

**Performance:**
- Total latency: 594 seconds
- Token usage: 453,309 + 10,201 = 463,510 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, update_plan, query-otel
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
