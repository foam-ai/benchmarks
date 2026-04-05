## TL;DR

The Terminal Velocity (TV) worker ran out of disk space on its EBS volume because git worktrees and lockfiles created under `/mnt/ebs/tv-lockfiles` and `/mnt/ebs/tv-worktrees` accumulated without bound — the maintenance cleanup code that prunes them never runs in production because the `TV_MAINTENANCE_WORKER_ENABLED` env var is absent from the ECS task definition, causing it to default to `false` and leaving the entire cleanup subsystem disabled. The fix is to add `TV_MAINTENANCE_WORKER_ENABLED=true` to the production ECS task definition and/or implement an external maintenance schedule.

---

## What Broke and Why

### The Immediate Failure (Symptom)

At 20:45:47 UTC on 2025-12-24, the TV worker failed with:
```
ENOSPC: no space left on device, open '/tmp/tv-lockfiles/worktree-Stream-claims-backend-1da599c41255134baccc9b84e36709526afb114d.lock'
```

This error fired instantly — all 3 retry attempts within each of the 2 queue-level attempts (~6 total) failed within ~1.5 seconds each. The EBS volume was already full before the job started; every `createWorktree()` call failed at the very first step: trying to open the lockfile with the `'wx'` flag (exclusive create). No git work was ever attempted.

### The Full Causal Chain

**Step 1 — How worktrees and lockfiles are created:**  
Every Terminal Velocity job calls `GitWorktreeService.createWorktree()` (`git-worktree.service.ts:596`), which begins by calling `acquireFileLock(lockName)` (`line 219`). This creates a `.lock` file at:
```
/tmp/tv-lockfiles/worktree-<repoOwner>-<repoName>-<gitSha>.lock
```
The four `/tmp/tv-*` directories inside the container are mounted from the EC2 host's EBS volume:
```json
{ "name": "tv-lockfiles", "host": { "sourcePath": "/mnt/ebs/tv-lockfiles" } }
```
This is a **persistent EBS volume shared across all TV worker containers** — not an ephemeral tmpfs. Data on it survives container restarts and accumulates across all jobs on the host.

**Step 2 — Per-job cleanup deliberately skips worktrees:**  
The per-job `cleanup()` method in `terminal-velocity.service.ts:1275` is explicit:
> "Worktrees are deliberately NOT removed here - they should be kept for 1 hour to allow reuse, and only cleaned up by scheduled maintenance."

This means every job that runs leaves behind a worktree directory on the EBS volume. Writable worktrees (unique per job with a `<sha>-writable-<uniqueId>` suffix) are never deduplicated and accumulate one-per-job.

**Step 3 — Lockfiles are not cleaned up on process crash:**  
`releaseFileLock()` (`line 316`) runs in `finally` blocks under normal completion, but if the worker process is killed (OOM, SIGKILL, crash), the `finally` block never executes and the `.lock` file is orphaned on the EBS volume. The inline stale-lock TTL (5 minutes, `handleExistingLock()`) only fires when another caller contends for the *same* lock — it cannot reclaim orphaned lockfiles for different jobs.

**Step 4 — The maintenance subsystem is the only safety net, and it never runs in production:**  
All cleanup — `cleanupOldWorktrees()`, `cleanupOldLockfiles()`, `performMaintenance()` — is gated behind:
```typescript
// src/keys.ts:58
export const TV_MAINTENANCE_WORKER_ENABLED = getEnvVar('TV_MAINTENANCE_WORKER_ENABLED') === 'true';
```
```typescript
// terminal-velocity.worker.ts:199
function createMaintenanceWorker() {
    if (!TV_MAINTENANCE_WORKER_ENABLED) {
        return undefined;  // ← exits immediately
    }
    ...
}
```
The production ECS task definition (`task-definition-tv.json`) contains only these six env vars for the `tv-worker` container:
```json
HOME, NODE_ENV, ENVIRONMENT, DOCKER_HOST, UV_CACHE_DIR, NODE_OPTIONS
```
`TV_MAINTENANCE_WORKER_ENABLED` is **completely absent**. With the env var unset, `getEnvVar(...) === 'true'` evaluates to `false`, so `createMaintenanceWorker()` returns `undefined`, the maintenance worker never starts, the in-memory maintenance queue never begins processing, and `performMaintenance()` is never called. The Docker entrypoint runs only `yarn tv-worker start` — never `yarn tv-worker maintenance`. There is no GitHub Actions cron, no EventBridge rule, and no scheduled ECS task that would invoke maintenance externally.

**Step 5 — Accumulation fills the EBS volume:**  
Because maintenance never runs, every job permanently deposits its worktree (potentially hundreds of MB of git working tree data) on the shared EBS volume. Over time — accelerated by high job throughput, job failures that crash the process mid-operation, and the retry logic submitting 6 total mini-solver attempts for a single issue — the EBS volume fills up entirely. Once full, even the lockfile creation step (`fs.open('wx', ...)`) throws `ENOSPC`, preventing any new job from starting. The error then becomes self-perpetuating: retries cannot clean up (no cleanup on retry), so every retry also fails immediately.

### Alternative Hypothesis Considered and Eliminated

**Hypothesis:** The `/tmp` path is a tmpfs with an undersized limit, not an EBS accumulation problem.  
**Eliminated by:** The ECS task definition explicitly uses EC2 host-path mounts from `/mnt/ebs/...`. There are no `linuxParameters.tmpfs` entries. The boot time of the EC2 instance (~6.6 minutes before the error) combined with the fact that the disk was *already* full at job start confirms this is a persistent-volume accumulation problem, not a per-boot ephemeral limit.

---

## Fix

### Immediate Fix: Enable the Maintenance Worker in Production

Add `TV_MAINTENANCE_WORKER_ENABLED=true` to the `tv-worker` container's environment in `task-definition-tv.json`:

```json
{ "name": "TV_MAINTENANCE_WORKER_ENABLED", "value": "true" }
```

This breaks the causal chain at **Step 4**: the maintenance worker will start, register as a listener on the in-memory maintenance queue, and begin processing cleanup jobs. When `performMaintenance()` is invoked (either externally or by also adding a periodic call), it will run `cleanupOldWorktrees()` (24-hour TTL, 1-hour minimum), `cleanupOldLockfiles()` (5-minute TTL), and container/git-gc cleanup.

### Additional Required Fix: Add Periodic Scheduling for `performMaintenance()`

Even with the flag enabled, the maintenance worker is purely event-driven — it only processes jobs that `performMaintenance()` enqueues into the in-memory queue. `performMaintenance()` itself has no automatic callers in the production code path. One of the following is needed:

**Option A — Add a `setInterval` in `startTerminalVelocityWorker()`:**
```typescript
if (TV_MAINTENANCE_WORKER_ENABLED) {
    // Run maintenance every 15 minutes
    setInterval(() => service.performMaintenance(), 15 * 60 * 1000);
}
```

**Option B — Add an EventBridge scheduled rule** that invokes a one-shot `yarn tv-worker maintenance` ECS task on a cron schedule (e.g., every 15 minutes).

### Emergency Mitigation (Immediate)

Manually run `yarn tv-worker maintenance` against the affected ECS host to free disk space, or manually clear stale entries from `/mnt/ebs/tv-lockfiles/` and `/mnt/ebs/tv-worktrees/` to unblock job processing.

### Why This Fix Is Sufficient

With `TV_MAINTENANCE_WORKER_ENABLED=true` and periodic scheduling of `performMaintenance()`, worktrees and lockfiles are pruned regularly. Even if process crashes orphan lockfiles, the 5-minute TTL cleanup (`cleanupOldLockfiles`) will reclaim them. The 24-hour TTL for worktrees (with 1-hour minimum) ensures they are removed well before the EBS volume fills. Retries can no longer exhaust disk space because the accumulation rate is bounded by the cleanup interval.

---