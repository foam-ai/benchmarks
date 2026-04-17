[Foam Trace ID: eb6275b692f57cb41055fcd3ebb3ded2] ## TL;DR

All 5 BullMQ queues in the `mono` repository omit `removeOnComplete` and `removeOnFail`, causing every completed and failed job to be permanently retained as a Redis hash in the shared ElastiCache instance. With job counters reaching at least 392,425 on `issue-solver-queue` alone, the Redis instance exhausted its `maxmemory` limit, causing BullMQ's periodic `extendLocks` Lua script to fail with an OOM error at the first write operation. The fix is to add `removeOnComplete` and `removeOnFail` retention limits to all 5 queue `defaultJobOptions`.

---

## What Broke and Why

### The Observed Failure

Span `65af1fb700df34f3` (trace `b2eb0b80f0a721f2a2b8b3c11c9f169d`) shows a BullMQ `extendLocks` heartbeat invocation against the `issue-solver-queue` failing with:

> `ReplyError: OOM command not allowed when used memory > 'maxmemory'. script: cc4eded989ba9b04d25cc2407a1142f33a30400e, on @user_script:26.`

The parent span (`c9d25acabb0ee8f3`, `extendLocks issue-solver-queue`) confirms this is BullMQ's routine worker lock-renewal cycle. The Redis target is the dedicated BullMQ ElastiCache instance at `redis-bullmq-1.c4lpp0.ng.0001.usw1.cache.amazonaws.com:6379`.

### What the Lua Script Does and Where It Fails

Script `cc4eded989ba9b04d25cc2407a1142f33a30400e` is BullMQ v5.56.5's `extendLocks` Lua script. It is called with:

```
EVALSHA cc4eded989ba9b04d25cc2407a1142f33a30400e 1
  bull:issue-solver-queue:stalled        ← KEYS[1]
  bull:issue-solver-queue:               ← ARGV[1] (prefix)
  d04f36da-...:392416                    ← ARGV[2] (job ID 1)
  d04f36da-...:392425                    ← ARGV[3] (job ID 2)
  130236  130237                         ← expiry tokens
  30000                                  ← lock duration ms
```

The script reads job state (read-only `EXISTS`, `ZSCORE` checks) and then — at **line 26** — performs the first write: an `SADD` into `bull:issue-solver-queue:stalled` to flag jobs whose locks have expired. Redis enforces `maxmemory` only at write-time, so the OOM guard fires precisely here, aborting the entire script. The consequence is that stalled job recovery is broken: stalled jobs cannot be moved back to `wait` for retry, and lock extensions fail across all active workers.

### The Root Cause: Unbounded Job Accumulation Across All 5 Queues

Every queue in the codebase omits `removeOnComplete` and `removeOnFail`. A repository-wide search returns **zero matches** for these options anywhere under `/repo/src`. All 5 queues follow this identical pattern:

```typescript
// e.g. src/queues/issue-solver.queue.ts — all 5 queues match this shape exactly
export const issueSolverQueue = new MonitoredQueue<IssueSolverRunJob>('issue-solver-queue', {
    connection: { host: REDIS_HOST, port: REDIS_PORT },
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        // ❌ removeOnComplete: absent
        // ❌ removeOnFail: absent
    },
});
```

By default, BullMQ **never removes** completed or failed jobs. Every job that finishes — success or failure — is permanently retained as a Redis hash at `bull:<queue>:{jobId}`. The telemetry confirms job IDs have reached at least `:392416` and `:392425` on `issue-solver-queue` alone, meaning hundreds of thousands of job records are accumulating indefinitely on the shared Redis instance.

All 5 queues and their corresponding workers share the same `REDIS_HOST:REDIS_PORT` endpoint (the single ElastiCache node):

| Queue | File |
|---|---|
| `issue-solver-queue` | `src/queues/issue-solver.queue.ts` |
| `rag-git-queue` | `src/queues/rags/git.queue.ts` |
| `rag-chroma-git-queue` | `src/queues/rags/chroma-git.queue.ts` |
| `pr-fixer-queue` | `src/queues/pr-fixer.queue.ts` |
| `terminal-velocity-queue` | `src/queues/terminal-velocity.queue.ts` |

A secondary compounding factor is the `MonitoredWorker` which always enables metrics with `maxDataPoints: MetricsTime.ONE_WEEK * 2` (up to ~20,160 per-minute counter entries per metric list per queue), but this is a minor contributor compared to hundreds of thousands of retained job hashes.

The ElastiCache instance uses the AWS default `noeviction` policy (no IaC exists in the repository to override it), meaning Redis rejects write operations rather than evicting keys when `maxmemory` is reached — which is exactly the OOM behavior observed.

### Full Causal Chain

1. **No `removeOnComplete`/`removeOnFail` set** on any of the 5 BullMQ queues.
2. → Every completed/failed job is **permanently retained** as a Redis hash across all 5 queues.
3. → Job hashes accumulate unboundedly; `issue-solver-queue` alone has processed 392,425+ jobs.
4. → The shared ElastiCache Redis instance gradually fills to its **`maxmemory` limit**.
5. → Redis `noeviction` policy means writes are **rejected** (not evicted) when the limit is hit.
6. → BullMQ's periodic `extendLocks` heartbeat invokes the `evalsha` Lua script; at **line 26**, the first write command (`SADD bull:issue-solver-queue:stalled`) is **rejected with OOM**.
7. → Stalled job recovery fails; worker lock renewal fails; jobs risk being lost or infinitely stalled.

---

## Fix

### Primary Fix — Application-Side (Required, addresses root cause directly)

Add `removeOnComplete` and `removeOnFail` to `defaultJobOptions` in **all 5 queue definitions**:

```typescript
defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 500 },   // retain last 500 completed jobs for observability
    removeOnFail: { count: 1000 },      // retain last 1000 failed jobs for debugging
},
```

This breaks the causal chain at step 1: once jobs are automatically removed after completion or failure, job hashes no longer accumulate indefinitely, Redis memory growth is bounded, and the `maxmemory` limit will not be re-hit from job accumulation alone.

**Immediate remediation**: After deploying the fix, the existing hundreds of thousands of stale job hashes still occupying Redis memory must be purged. Use BullMQ's `queue.clean(gracePeriod, limit, 'completed')` and `queue.clean(gracePeriod, limit, 'failed')` against all 5 queues to reclaim the accumulated memory.

### Secondary Measure — Infrastructure (Recommended)

The ElastiCache instance's `maxmemory` limit and node type are managed outside this repository (no IaC found in the codebase). As a complementary measure, consider:
- **Upgrading the ElastiCache node type** to provide headroom against any future accumulation.
- **Setting `maxmemory-policy` to `allkeys-lru`** as a safety net so Redis gracefully evicts stale data under memory pressure rather than rejecting all writes — though this should not be relied upon as a substitute for the application-side fix.


---
