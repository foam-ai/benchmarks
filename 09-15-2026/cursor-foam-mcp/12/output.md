## TL;DR

The EBS volume on the Terminal Velocity EC2 instance is 100% full because every solution job creates a writable git worktree and `cleanup()` intentionally skips removing it, deferring to a scheduled maintenance task that was never implemented.

## What Broke and Why

**Observed error:** `ENOSPC: no space left on device, open '/mnt/tv/locks/....lock'`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** `df` on the instance shows the data volume at 100%.

**2.** `cleanup()` has an explicit early return with a TODO referencing a maintenance job that does not exist.

**3.** Even the lockfile create fails once the disk is full.

## Fix

- Remove the worktree in `cleanup()` (or implement the maintenance job with a TTL) and add disk-usage alerting.

---

## Metrics

**Performance:**
- Total latency: 528 seconds
- Token usage: 425,971 + 11,003 = 436,974 tokens

**Tool Usage:**
- Top 3 most-used tools: list_dir, codebase_search, grep
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) read_file (input: the throwing function and its callers) grep (input: the error string across the repo)
