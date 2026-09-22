## TL;DR

The `git` binary is missing from the ECS worker image, so pre-flight checks fail; the 2-hour timeout is a secondary symptom of the missing failure propagation.

## What Broke and Why

**Observed error:** `Error: Working directory is not clean (git-operations.ts) ... Job timed out after 7200000ms`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** `git` commands fail inside the container.

**2.** The job stays active until the timeout.

## Fix

- Install git in the image and fail fast on pre-flight errors.

---

## Metrics

**Performance:**
- Total latency: 578 seconds
- Token usage: 397,879 + 7,582 = 405,461 tokens

**Tool Usage:**
- Top 3 most-used tools: Bash, Glob, Grep
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) Read (input: the throwing function and its callers) Grep (input: the error string across the repo)
