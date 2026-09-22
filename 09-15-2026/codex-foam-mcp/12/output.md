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
- Total latency: 278 seconds
- Token usage: 465,477 + 16,261 = 481,738 tokens

**Tool Usage:**
- Top 3 most-used tools: shell, list_dir, read_file
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
