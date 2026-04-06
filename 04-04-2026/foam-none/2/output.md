[Foam Trace ID: c36e44dd04c70e154be495187f81ba61] ## TL;DR

Redis OOM on the dedicated BullMQ ElastiCache instance (`redis-bullmq-1`) because `removeOnComplete` and `removeOnFail` are not configured on any BullMQ queue in the repository, causing 130,000+ completed/failed job HASH keys (with their data, return values, logs, and metadata) to accumulate in Redis indefinitely until `maxmemory` is exhausted. The fix is to add `removeOnComplete` and `removeOnFail` to the queue's `defaultJobOptions`.

## What Broke and Why

The error manifests as a `ReplyError: OOM command not allowed when used memory > 'maxmemory'` at line 26 of BullMQ's `extendLocks-1.lua` Lua script, which attempts an `SADD` to `bull:issue-solver-queue:stalled` — a trivial write that Redis rejects because the instance has exceeded its `maxmemory` limit under a `noeviction` policy.

**The crash site is a symptom.** The root cause is unbounded accumulation of BullMQ job data in Redis due to missing cleanup configuration.

### The Causal Chain

**Step 1 — No job cleanup is configured.** The `issue-solver-queue` is instantiated in `/repo/src/queues/issue-solver.queue.ts`:

```typescript
export const issueSolverQueue = new MonitoredQueue<IssueSolverRunJob>('issue-solver-queue', {
    connection: { host: REDIS_HOST, port: REDIS_PORT },
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
    },
    // ...
});
```

`removeOnComplete` and `removeOnFail` are **absent** from `defaultJobOptions`. BullMQ defaults both to `false`, meaning every completed or failed job's Redis HASH key (`bull:issue-solver-queue:<jobId>`) — containing serialized `data`, `returnvalue`, logs, timestamps, and metadata — persists in Redis forever. A repository-wide search confirmed **zero occurrences** of `removeOnComplete` or `removeOnFail` across the entire codebase, and **zero calls** to `queue.clean()` or `queue.obliterate()`. This is a project-wide omission affecting all queues (`issue-solver-queue`, `pr-fixer-queue`, `terminal-velocity-queue`, `rag-git-queue`, `rag-chroma-git-queue`).

Neither `queue.add()` call site passes per-job removal options:
```typescript
// /repo/src/services/issue-solver/utils.ts:117
await issueSolverQueue.add(jobName, { runId, notificationsEnabled: !forceRun, version: SNIPPET_VERSION });
```

**Step 2 — Job data accumulates without bound.** Telemetry shows job IDs in the range of `130236`–`130237`, confirming over 130,000 jobs have been created. Each job creates a Redis HASH key storing the payload, return value (whatever the processor function returns), and any `job.log()` entries. Even with the small input payload (`{ runId, notificationsEnabled, version }`), the processor's return value and logs add up — and with 130K+ retained jobs, the total memory consumed by job hashes grows monotonically.

**Step 3 — Redis reaches `maxmemory`.** The dedicated BullMQ ElastiCache instance (`redis-bullmq-1.c4lpp0.ng.0001.usw1.cache.amazonaws.com:6379`) is configured with a `noeviction` policy (confirmed by the OOM error behavior — writes are rejected rather than keys being evicted). This is the correct policy for BullMQ (evicting job data would cause queue corruption), but it means there is no safety valve: once `maxmemory` is reached, **all write operations fail**.

**Step 4 — Lock extension fails, cascading into stalled jobs.** The BullMQ Worker (concurrency: 5, `maxStalledCount: 5`) periodically extends locks on jobs it's processing via the `extendLocks` Lua script every ~15 seconds. When this script attempts a write (`SADD` to the stalled set on line 26), Redis rejects it with OOM. The telemetry confirms:

```
evalsha cc4eded989ba9b04d25cc2407a1142f33a30400e 1 
  bull:issue-solver-queue:stalled 
  bull:issue-solver-queue: 
  d04f36da-6ee5-4e64-80ec-0beec88a1db8:392416
  d04f36da-6ee5-4e64-80ec-0beec88a1db8:392425 
  130236 130237 
  30000
```

With lock extensions failing, in-progress jobs' locks expire, BullMQ marks them as stalled and attempts to re-enqueue them (also a write, also OOM), creating a complete queue failure where no jobs can be processed, completed, or cleaned up.

### Alternative Hypothesis Considered

**Concurrent load spike:** Could a sudden burst of job creation have overwhelmed Redis? This was ruled out because: (a) the complete absence of `removeOnComplete`/`removeOnFail` and zero cleanup mechanisms is a deterministic path to OOM regardless of load pattern — memory grows monotonically with every job processed; (b) the high job IDs (130K+) indicate steady long-term accumulation rather than a spike; (c) even if job creation slowed to zero, the already-accumulated data would still cause OOM.

## Fix

Add `removeOnComplete` and `removeOnFail` to the `defaultJobOptions` in `/repo/src/queues/issue-solver.queue.ts`:

```typescript
export const issueSolverQueue = new MonitoredQueue<IssueSolverRunJob>('issue-solver-queue', {
    connection: { host: REDIS_HOST, port: REDIS_PORT },
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },  // Keep last 1000 completed jobs for observability
        removeOnFail: { count: 5000 },      // Keep last 5000 failed jobs for debugging
    },
    // ...
});
```

Apply the same fix to **all other queues** (`pr-fixer-queue`, `terminal-velocity-queue`, `rag-git-queue`, `rag-chroma-git-queue`) since they all share the same omission.

**Why this fixes the root cause:** With `removeOnComplete` and `removeOnFail` configured, BullMQ automatically deletes old job HASH keys (including their `data`, `returnvalue`, and `logs`) when the retention count is exceeded. This converts Redis memory usage from monotonically growing (unbounded) to bounded (capped at `count` most recent jobs), preventing the `maxmemory` from ever being reached under normal operation.

**Immediate remediation:** Before the code fix takes effect, run a one-time cleanup to reclaim memory from the 130K+ accumulated jobs:
```typescript
await issueSolverQueue.clean(0, 1000, 'completed');  // Remove completed jobs older than 0ms, keep 1000
await issueSolverQueue.clean(0, 5000, 'failed');      // Remove failed jobs older than 0ms, keep 5000
```

---
