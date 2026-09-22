## TL;DR

The EBS volume on the Terminal Velocity EC2 instance is 100% full because every solution job creates a writable git worktree and `cleanup()` intentionally skips removing it, deferring to a scheduled maintenance task that was never implemented.

## What Broke and Why

**Observed error:** `ENOSPC: no space left on device, open '/mnt/tv/locks/....lock'`

### Causal Chain

**1.** `df` on the instance shows the data volume at 100%.

**2.** `cleanup()` has an explicit early return with a TODO referencing a maintenance job that does not exist.

**3.** Even the lockfile create fails once the disk is full.

## Fix

- Remove the worktree in `cleanup()` (or implement the maintenance job with a TTL) and add disk-usage alerting.

---

## Metrics

**Performance:**
- Total latency: 242 seconds
- Token usage: 360,691 + 13,710 = 374,401 tokens

**Tool Usage:**
- Top 3 most-used tools: Glob, Agent, Grep
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
