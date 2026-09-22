[Foam Trace ID: fe57efa7d0c8d7d44a0223f8b155c4bf] ## TL;DR

The BullMQ ElastiCache instance hit `maxmemory` with a `noeviction` policy, so every Lua script BullMQ runs to move job state is rejected; memory was consumed by `issue-solver-queue` job data with no cleanup policy and by `terminal-velocity-queue` jobs that no worker consumes.

## What Broke and Why

**Observed error:** `ReplyError: OOM command not allowed when used memory > 'maxmemory'`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** `redis-bullmq-1` reports used memory at the configured `maxmemory` and `maxmemory-policy noeviction`.

**2.** `issue-solver-queue` is created without `removeOnComplete`/`removeOnFail`, so completed job payloads accumulate indefinitely.

**3.** `terminal-velocity-queue` has producers but no running worker in `mono`, so its waiting list grows without bound.

**4.** Evals were unaffected because they use a separate Redis instance.

## Fix

- Add `removeOnComplete`/`removeOnFail` retention to both queues and drain or delete the orphaned `terminal-velocity-queue`.
- Alert on ElastiCache memory utilisation and consider a larger node class.


---
