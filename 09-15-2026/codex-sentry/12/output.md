## TL;DR

The EBS volume on the Terminal Velocity EC2 instance is 100% full because every solution job creates a writable git worktree and `cleanup()` intentionally skips removing it, deferring to a scheduled maintenance task that was never implemented.

## What Broke and Why

**Observed error:** `ENOSPC: no space left on device, open '/mnt/tv/locks/....lock'`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** `df` on the instance shows the data volume at 100%.

**2.** `cleanup()` has an explicit early return with a TODO referencing a maintenance job that does not exist.

**3.** Even the lockfile create fails once the disk is full.

## Fix

- Remove the worktree in `cleanup()` (or implement the maintenance job with a TTL) and add disk-usage alerting.

---

## Metrics

**Performance:**
- Total latency: 400 seconds
- Token usage: 347,305 + 11,043 = 358,348 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, update_plan, get_sentry_resource
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
