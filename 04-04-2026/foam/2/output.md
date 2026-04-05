## TL;DR

Redis OOM on the `redis-bullmq-1` ElastiCache instance was caused by unbounded accumulation of BullMQ job data across all five queues — completed and failed jobs are never removed from Redis because `removeOnComplete` and `removeOnFail` are not configured anywhere in the codebase. With job IDs reaching 130,000+, hundreds of thousands of persistent Redis hashes have accumulated with no TTL or cleanup mechanism, exhausting the instance's `maxmemory` limit (which uses `noeviction` policy, causing writes to be blocked outright). The fix is to add `removeOnComplete` and `removeOnFail` limits to every queue's `defaultJobOptions`.

---

## What Broke and Why

### The Trigger

At `2026-01-29 07:05:10`, a routine BullMQ `extendLocks` call on the `issue-solver-queue` was rejected with:

```
OOM command not allowed when used memory > 'maxmemory'.
script: cc4eded989ba9b04d25cc2407a1142f33a30400e, on @user_script:26.
```

This Lua script (`extendLocks`) is BullMQ's internal heartbeat mechanism — every ~30 seconds per active worker, it writes to `bull:issue-solver-queue:stalled` to refresh lock TTLs for in-progress jobs. This is not application logic; it is background infrastructure. The failure did not happen because `extendLocks` itself was doing anything unusual — it happened because Redis was already at capacity and the ElastiCache instance is configured with a `noeviction` policy, meaning any write is rejected once `maxmemory` is breached.

### Why Redis Was Full

The root cause is that **completed and failed BullMQ jobs are never removed from Redis**. The search across the entire `/repo/src` directory returns zero hits for `removeOnComplete`, `removeOnFail`, or `keepJobs`:

```
grep -rn 'removeOnComplete|removeOnFail|keepJobs|obliterate' /repo/src
(no results)
```

Every queue definition follows the same pattern — only `attempts` and `backoff` in `defaultJobOptions`, with no retention limits:

```typescript
// /repo/src/queues/issue-solver.queue.ts
export const issueSolverQueue = new MonitoredQueue<IssueSolverRunJob>('issue-solver-queue', {
    connection: { host: REDIS_HOST, port: REDIS_PORT },
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        // ← NO removeOnComplete, NO removeOnFail
    },
    ...
});
```

This applies to all five queues: `issue-solver-queue`, `terminal-velocity-queue`, `pr-fixer-queue`, the RAG git queue, and the RAG chroma-git queue.

### What Accumulates Per Job

BullMQ stores the following in Redis for every job, indefinitely:

- **Job hash** at `bull:<queue>:<jobId>` — contains job data, options, attempt metadata, timestamps, return value, and any job log entries written via `job.log(...)` (the `issue-solver` worker does call `job.log('Processing job')`).
- **A sorted-set entry** in either `bull:<queue>:completed` or `bull:<queue>:failed`.

The job payload itself is tiny (`runId` + `version` + `notificationsEnabled` ≈ 200 bytes), and large AI artifacts (model outputs, diffs, code) are correctly stored in MongoDB/S3 — not in Redis. However, the per-job overhead from BullMQ metadata, timestamps, and logs still accumulates. With job IDs at 130,236+ at time of failure, there are over 130,000 job hashes in Redis with no eviction path.

### The Metrics Multiplier

The shared `MonitoredWorker` base class in `/repo/src/queues/worker.ts` applies a default metrics configuration to every worker:

```typescript
// /repo/src/queues/worker.ts:85-87
const metricsConfig = opts.metrics || {
    maxDataPoints: MetricsTime.ONE_WEEK * 2,  // ~20,160 data points
};
```

`MetricsTime.ONE_WEEK * 2` = 20,160 minutes of per-minute metrics. BullMQ stores these in Redis lists capped at that size. With 5 queues × 2 metric dimensions (completed + failed) × 20,160 entries, this alone represents ~200,000 Redis list entries held at steady state — a significant and permanent baseline memory footprint that no worker overrides.

### Why the Error Manifests as `extendLocks`

The OOM state was gradual: jobs 130236 and 130237 had been running for 46+ continuous minutes with lock extensions firing every ~8–10 seconds (295 total calls observed in the trace). Only 2 of those 295 calls hit OOM — the memory threshold was crossed during this window. The `extendLocks` script was simply the first write to arrive after the threshold was exceeded. Any other BullMQ write (enqueue, complete, fail, add metrics) would have produced the same error.

### Why the Instance Can't Self-Recover

The ElastiCache instance uses `noeviction` (evidenced by the error message itself — `allkeys-lru` or similar would evict a key instead of rejecting the write). There are no application-level cleanup jobs, no `Queue.obliterate()` calls, and no scheduled maintenance. Redis has no path to free memory on its own.

---

## Fix

### Immediate Fix: Add Job Retention Limits to All Queue Definitions

Add `removeOnComplete` and `removeOnFail` to `defaultJobOptions` in every queue. The simplest change is in the shared `MonitoredQueue` constructor default, but the most transparent change is at each queue definition. Example for `issue-solver-queue`:

```typescript
// /repo/src/queues/issue-solver.queue.ts
export const issueSolverQueue = new MonitoredQueue<IssueSolverRunJob>('issue-solver-queue', {
    connection: { host: REDIS_HOST, port: REDIS_PORT },
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },   // keep last 1,000 completed jobs
        removeOnFail: { count: 5000 },        // keep last 5,000 failed jobs for debugging
    },
    ...
});
```

Apply the same to all other queues (`terminal-velocity`, `pr-fixer`, `rags/git`, `rags/chroma-git`) or encode it as a default in `MonitoredQueue`'s constructor.

**Why this breaks the causal chain:** BullMQ's `removeOnComplete`/`removeOnFail` hooks delete the job hash and remove the sorted-set entry atomically when a job transitions to completed/failed state. With a count cap of 1,000, Redis will never hold more than 1,000 completed job hashes for any given queue, regardless of throughput. This directly eliminates the mechanism by which 130,000+ job hashes accumulated without bound.

### One-Time Remediation

After deploying the fix, manually drain the accumulated completed/failed job sets using BullMQ's `Queue.clean()` API or via `redis-cli` to reclaim existing memory:

```typescript
await issueSolverQueue.clean(0, 100000, 'completed');
await issueSolverQueue.clean(0, 100000, 'failed');
// repeat for all queues
```

### Secondary Improvement: Reduce Metrics Retention

Reduce `maxDataPoints` in `MonitoredWorker` from `MetricsTime.ONE_WEEK * 2` to `MetricsTime.ONE_WEEK` or less to cut the metrics baseline from ~200,000 to ~100,000 Redis list entries:

```typescript
// /repo/src/queues/worker.ts
const metricsConfig = opts.metrics || {
    maxDataPoints: MetricsTime.ONE_WEEK,  // 1 week instead of 2
};
```

### Infrastructure Safeguard

Change the ElastiCache `maxmemory-policy` from `noeviction` to `allkeys-lru` (or `volatile-lru` if keys use TTLs). This provides a last-resort defense so that if application-level cleanup ever lags, Redis evicts the least-recently-used keys instead of blocking all writes.


---