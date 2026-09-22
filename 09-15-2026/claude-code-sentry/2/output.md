## TL;DR

The BullMQ ElastiCache instance hit `maxmemory` with a `noeviction` policy, so every Lua script BullMQ runs to move job state is rejected; memory was consumed by `issue-solver-queue` job data with no cleanup policy and by `terminal-velocity-queue` jobs that no worker consumes.

## What Broke and Why

**Observed error:** `ReplyError: OOM command not allowed when used memory > 'maxmemory'`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** `redis-bullmq-1` reports used memory at the configured `maxmemory` and `maxmemory-policy noeviction`.

**2.** `issue-solver-queue` is created without `removeOnComplete`/`removeOnFail`, so completed job payloads accumulate indefinitely.

**3.** `terminal-velocity-queue` has producers but no running worker in `mono`, so its waiting list grows without bound.

**4.** Evals were unaffected because they use a separate Redis instance.

## Fix

- Add `removeOnComplete`/`removeOnFail` retention to both queues and drain or delete the orphaned `terminal-velocity-queue`.
- Alert on ElastiCache memory utilisation and consider a larger node class.

---

## Metrics

**Performance:**
- Total latency: 360 seconds
- Token usage: 252,900 + 16,960 = 269,860 tokens

**Tool Usage:**
- Top 3 most-used tools: search_issue_events, Read, Glob
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
