[Foam Trace ID: c97cc3a9203442b84880378f45e67dba] ## TL;DR

An agent generated a `FULL OUTER JOIN` between `otel_logs` and `otel_traces` on `DATE(Timestamp)`, producing a per-day cross-product that exhausted memory. `queryOtel` has no per-query memory budget and its validation is syntax-only, so the query ran.

## What Broke and Why

**Observed error:** `ClickHouse error: Memory limit (for query) exceeded`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** Joining on a low-cardinality date key multiplies rows per day.

**2.** Twenty parallel agents amplified the blast radius, but this specific join is what OOMed.

## Fix

- Set `max_memory_usage`/`max_execution_time` per query in `queryOtel` and reject joins without a selective key.


---
