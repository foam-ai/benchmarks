## TL;DR

The `--sha` pre-flight cannot run inside ECS workers because the deployed artifact has no git metadata; the check fails and the job hangs until the timeout.

## What Broke and Why

**Observed error:** `Error: Working directory is not clean (git-operations.ts) ... Job timed out after 7200000ms`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** Containers are deployed as built artifacts.

**2.** The rejection is not surfaced to the job.

## Fix

- Disable the git pre-flight for remote workers; make pre-flight failures fail the job.

---

## Metrics

**Performance:**
- Total latency: 578 seconds
- Token usage: 397,879 + 7,582 = 405,461 tokens

**Tool Usage:**
- Top 3 most-used tools: Bash, Glob, Grep
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) Read (input: the throwing function and its callers) Grep (input: the error string across the repo)
