## TL;DR
BullMQ queues never clean up completed/failed jobs from Redis, causing unbounded memory growth until Redis hits its `maxmemory` limit and rejects all write operations.

## What Broke and Why
The application uses 5 BullMQ queues (`terminal-velocity-queue`, `issue-solver-queue`, `pr-fixer-queue`, `rag-git-queue`, `rag-chroma-git-queue`) all backed by a single shared Redis instance. **None of these queues configure `removeOnComplete` or `removeOnFail`** in their `defaultJobOptions`.

By default, BullMQ retains all completed and failed job data in Redis indefinitely. Each job stores its full payload, logs, return values, and metadata as Redis keys. Over time — especially for high-throughput queues like `terminal-velocity-queue` (which has concurrency of 30 and 5 retry attempts per job) — this creates unbounded memory growth.

The causality chain:
1. Jobs are processed continuously across 5 queues, with the terminal-velocity queue being the highest throughput
2. BullMQ stores completed/failed job data in Redis with no TTL or count limit (no `removeOnComplete`/`removeOnFail` configured on any queue)
3. Redis memory usage grows monotonically over days/weeks
4. Redis hits its configured `maxmemory` limit
5. BullMQ's internal Lua scripts (hash `cc4eded989ba9b04d25cc2407a1142f33a30400e`) attempt write operations (e.g., adding new jobs, updating job state) which Redis rejects with `OOM command not allowed when used memory > 'maxmemory'`
6. All queue operations fail — new jobs cannot be enqueued, existing jobs cannot transition states, and the entire job processing pipeline halts

Additionally contributing to memory pressure:
- The `MonitoredWorker` configures metrics retention of `MetricsTime.ONE_WEEK * 2` (2 weeks of per-minute metric data points per queue)
- The dashboard caches solve pages with a 90-day TTL (`TTLNinetyDays = 60 * 60 * 24 * 90`), which accumulates large JSON payloads in Redis for every unique run viewed
- Three separate `ioredis` client instances are created (in `cache.ts`, `stats.ts`, `dashboard.ts`) in addition to the BullMQ connections, all sharing the same Redis instance

## Fix

**Primary fix — add `removeOnComplete` and `removeOnFail` to all queue configurations:**

Each queue definition file needs cleanup options added to `defaultJobOptions`. For example, in `src/queues/terminal-velocity.queue.ts`:

```typescript
defaultJobOptions: {
    attempts: 5,
    backoff: {
        type: 'fixed',
        delay: 30000,
    },
    removeOnComplete: {
        age: 3600,    // Remove completed jobs older than 1 hour
        count: 1000,  // Keep at most 1000 recent completed jobs
    },
    removeOnFail: {
        age: 86400,   // Remove failed jobs older than 24 hours (keep for debugging)
    },
},
```

Apply the same pattern to all 5 queues:
- `src/queues/terminal-velocity.queue.ts`
- `src/queues/issue-solver.queue.ts`
- `src/queues/pr-fixer.queue.ts`
- `src/queues/rags/git.queue.ts`
- `src/queues/rags/chroma-git.queue.ts`

**Secondary fix — reduce the 90-day cache TTL in `src/pages/dashboard.ts`:**

Change the solve page cache TTL from 90 days to something more reasonable (e.g., 7 days):

```typescript
const TTLSevenDays = 60 * 60 * 24 * 7;  // was TTLNinetyDays = 60 * 60 * 24 * 90
await redis.set(cacheKey, JSON.stringify(dashboardRow), 'EX', TTLSevenDays);
```

**Immediate remediation (if Redis is currently OOM):**

Run a one-time cleanup of stale BullMQ jobs using the BullMQ CLI or a script:
```bash
# Clean completed jobs from all queues
npx bullmq clean terminal-velocity-queue completed 3600000
npx bullmq clean issue-solver-queue completed 3600000
npx bullmq clean pr-fixer-queue completed 3600000
npx bullmq clean rag-git-queue completed 3600000
npx bullmq clean rag-chroma-git-queue completed 3600000
```

Or increase Redis `maxmemory` as a short-term bandaid while deploying the code fix.

---
