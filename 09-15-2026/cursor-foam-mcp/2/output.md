## TL;DR

The BullMQ ElastiCache instance hit `maxmemory` with a `noeviction` policy, so every Lua script BullMQ runs to move job state is rejected; memory was consumed by `issue-solver-queue` job data with no cleanup policy and by `terminal-velocity-queue` jobs that no worker consumes.

## What Broke and Why

**Observed error:** `ReplyError: OOM command not allowed when used memory > 'maxmemory'`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

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
- Total latency: 509 seconds
- Token usage: 435,993 + 18,866 = 454,859 tokens

**Tool Usage:**
- Top 3 most-used tools: list_dir, codebase_search, read_file
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) read_file (input: the throwing function and its callers) grep (input: the error string across the repo)
