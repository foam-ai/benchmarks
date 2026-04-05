## TL;DR
All five BullMQ queues lack `removeOnComplete` and `removeOnFail` settings, so every completed/failed job is retained in Redis forever, eventually exhausting `maxmemory` and causing OOM errors on any BullMQ Lua script write.

## What Broke and Why
The error `OOM command not allowed when used memory > 'maxmemory'` is thrown by Redis when a BullMQ internal Lua script (hash `cc4eded989ba9b04d25cc2407a1142f33a30400e`, line 26) attempts a write operation (e.g., `HSET`, `ZADD`) but Redis has hit its configured `maxmemory` ceiling.

The root cause is that none of the five BullMQ-backed queues in the codebase configure `removeOnComplete` or `removeOnFail` in their `defaultJobOptions`:

1. **`issue-solver-queue`** (`src/queues/issue-solver.queue.ts`) — no removal
2. **`terminal-velocity-queue`** (`src/queues/terminal-velocity.queue.ts`) — no removal, concurrency 30, 5 retry attempts
3. **`pr-fixer-queue`** (`src/queues/pr-fixer.queue.ts`) — no removal
4. **`rag-git-queue`** (`src/queues/rags/git.queue.ts`) — no removal
5. **`rag-chroma-git-queue`** (`src/queues/rags/chroma-git.queue.ts`) — no removal

Without these options, BullMQ's default behavior is to **keep every job record in Redis indefinitely** — the full job data, job logs (via `job.log()`), progress updates (via `job.updateProgress()`), and per-job metric data all accumulate over time. The `terminal-velocity-queue` is the most impactful contributor because it has the largest job payload (`prompt: Record<string, string>`, harness args, serialized Braintrust spans, Sentry trace headers, etc.), the highest concurrency (30), and the most retry attempts (5), and every worker invocation writes multiple log entries and progress updates to Redis.

Additionally, the `MonitoredWorker` base class configures BullMQ metrics with `MetricsTime.ONE_WEEK * 2` (two weeks of data points), which stores per-minute metric counters in Redis lists — further adding to memory pressure.

The causality chain:
1. Jobs are created and processed across all five queues continuously in production.
2. Completed and failed jobs are never removed from Redis.
3. Each retained job stores its full data hash, log entries, progress objects, and metric counters.
4. Over days/weeks, Redis memory grows monotonically until it hits the configured `maxmemory` limit.
5. Once at `maxmemory`, any BullMQ operation that writes to Redis (adding a job, completing a job, moving a job between states) triggers the OOM error inside BullMQ's Lua scripts, since Redis refuses all write commands.

## Fix
Add `removeOnComplete` and `removeOnFail` to the `defaultJobOptions` of every BullMQ queue. Keep a small number of recent jobs for debugging visibility (e.g., 100 completed, 200 failed):

**All five queue files need the same change pattern.** For example, in `src/queues/issue-solver.queue.ts`:

```typescript
export const issueSolverQueue = new MonitoredQueue<IssueSolverRunJob>('issue-solver-queue', {
    connection: {
        host: REDIS_HOST,
        port: REDIS_PORT,
    },
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
        removeOnComplete: {
            age: 24 * 3600,  // Keep completed jobs for 24 hours
            count: 100,       // Keep at most 100 completed jobs
        },
        removeOnFail: {
            age: 7 * 24 * 3600,  // Keep failed jobs for 7 days
            count: 200,            // Keep at most 200 failed jobs
        },
    },
    monitoring: {
        pagerDutyRoutingKey: PAGERDUTY_ISSUE_SOLVER_INTEGRATION_KEY,
        queueDepthThreshold: 20,
        failedCountPerHourThreshold: 3,
    },
});
```

Apply the same `removeOnComplete` and `removeOnFail` to:
- `src/queues/terminal-velocity.queue.ts`
- `src/queues/pr-fixer.queue.ts`
- `src/queues/rags/git.queue.ts`
- `src/queues/rags/chroma-git.queue.ts`

**Immediate remediation:** Run `redis-cli` against the production Redis instance to manually clean old completed/failed jobs from each queue using BullMQ's key patterns (e.g., `DEL bull:issue-solver-queue:completed`, or use Bull Board / BullMQ's `Queue.clean()` API to purge historical jobs and free memory immediately).
