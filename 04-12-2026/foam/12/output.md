[Foam Trace ID: 7cdbba13b77eeabd906324b74291cecb] ## TL;DR

Git worktree directories written to `/tmp/tv-worktrees/` by concurrent Terminal Velocity jobs accumulated unchecked on an ECS Fargate container (exhausting ephemeral `/tmp` storage within ~34 minutes of boot) because `performMaintenance()` / `cleanupOldWorktrees()` has **no automatic in-process periodic scheduler** — it is only callable as a one-shot CLI command. When the IssueSolver job then tried to create a tiny lock file in the already-full `/tmp/tv-lockfiles/`, every attempt (including all 3 retries) failed with `ENOSPC`, and the retry wrapper has no disk-recovery logic to break the cycle. The fix is to wire a periodic in-process scheduler for `cleanupOldWorktrees()` inside the long-running TV worker, with a meaningfully shorter retention threshold.

---

## What Broke and Why

### 1. Worktree directories are intentionally long-lived and accumulate without automatic cleanup

When a Terminal Velocity job runs, `GitWorktreeService.createWorktree()` checks out a git repository into `/tmp/tv-worktrees/<customerId>/<owner-repo>/<sha>/`. The service **deliberately does not remove this directory on success or failure**, as documented in a code comment: *"Worktrees are deliberately NOT removed here — they should be kept for 1 hour to allow reuse, and only cleaned up by scheduled maintenance."* The cleanup function `cleanupOldWorktrees()` enforces a **hard minimum age of 1 hour** and a **default age threshold of 24 hours** before any worktree becomes eligible for deletion.

### 2. No periodic scheduler ever calls `performMaintenance()` inside the worker process

`performMaintenance()` in `terminal-velocity.service.ts` is the only function that invokes `cleanupOldWorktrees()`. A repo-wide code search confirms it is called in exactly two places: its own definition and `runMaintenance()` in `src/bin/tv-worker.ts` — the handler for the one-shot CLI command `yarn tv-worker maintenance`. **There is no `setInterval`, cron expression, BullMQ repeatable job, or any other periodic trigger inside the long-running worker process.** The in-memory maintenance queue (gated behind `TV_MAINTENANCE_WORKER_ENABLED=true`) only processes jobs already enqueued by `performMaintenance()` — it does not independently schedule worktree cleanup.

### 3. Disk exhausted within 34 minutes of container start

The ECS Fargate container booted at approximately **06:11 UTC**. By **06:45–06:46 UTC** (only ~34 minutes later), concurrent TV jobs had written enough large git worktree checkouts to `/tmp` that the ephemeral filesystem was 100% full. Even under any realistic external scheduling cadence for `yarn tv-worker maintenance`, no maintenance call could have run in that window. And even if one had, the 1-hour minimum retention age would have prevented removal of any worktree created during that same 34-minute window.

### 4. Lock-file `open()` fails with `ENOSPC` — not just the worktree write

When the IssueSolver job attempted to create the worktree for `Stream-claims-backend` at commit `1da599c41255134…`, `createWorktree()` first called `acquireFileLock()`, which attempted:
```
fs.open('/tmp/tv-lockfiles/worktree-Stream-claims-backend-1da599c41255134baccc9b84e36709526afb114d.lock', 'wx')
```
Because the underlying filesystem block device was completely full, even this tiny metadata file could not be created. The error thrown was:
```
ENOSPC: no space left on device, open '/tmp/tv-lockfiles/worktree-Stream-claims-backend-1da599c41255134baccc9b84e36709526afb114d.lock'
```
Note: the stale-lock detection path (which proactively unlinks existing locks older than 5 minutes) is gated on `EEXIST` — it is completely bypassed when `open()` fails with `ENOSPC`, because the file never even exists.

### 5. Retry wrapper is structurally incapable of recovering from a full disk

`withTerminalVelocityRetry` in `terminal-velocity-retry.service.ts` executes this loop:
```typescript
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
        const result = await operation();   // ← tries to open lock file, ENOSPC
        return result;
    } catch (error) {
        // log + Sentry capture
        if (attempt >= maxAttempts) { break; }
        // NO cleanup, NO disk recovery, NO worktree eviction
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));  // just waits
    }
}
```
Between attempts it only sleeps (2 s → 4 s exponential back-off). It does not call `cleanupOldWorktrees()`, trigger `performMaintenance()`, or perform any filesystem-recovery action. Since the disk was persistently full before attempt 1 and nothing freed space during the back-off windows, all three attempts failed with identical `ENOSPC` errors at **20:45:47**, **20:45:54**, and **20:46:04** respectively — the same lock-file path, the same error, every time.

### 6. Final error propagated

After all 3 attempts exhausted, `withTerminalVelocityRetry` threw a `TerminalVelocityRetryableError` (with `willRetry: false`), which propagated up through `solveIssue()` → the issue-solver worker → the BullMQ job handler, permanently failing IssueSolver job 127988 (runId `3daa8451-d9fa-4b72-b3f5-82e880115e76`).

### Alternative hypotheses considered and eliminated

- **Inode exhaustion vs. block exhaustion**: Both manifest as `ENOSPC` on `open()`; the lock file failure is consistent with either, but the root accumulation mechanism (large git worktree directories) makes block exhaustion the more probable sub-type. Either way, the fix is the same.
- **Orphaned lock files filling the disk**: Lock files are tiny JSON blobs (a few hundred bytes). Even hundreds of them would not exhaust a Fargate ephemeral volume. The `finally` block in `createWorktree()` guarantees lock-file release on all non-crash exits. Lock files are ruled out as the disk-filling cause.
- **A process crash leaving orphaned worktrees** (vs. intentional retention design): The code contains an explicit comment confirming worktrees are intentionally retained for reuse, with cleanup deferred to maintenance. This is not a crash-path bug — it is a design choice whose cleanup side was never automated.

---

## Fix

### Root-Cause Fix: Add a periodic in-process scheduler for `cleanupOldWorktrees()` in the TV worker

Wire a `setInterval` (or a BullMQ repeatable job backed by Redis, to survive process restarts) inside `startTerminalVelocityWorker()` that calls `cleanupOldWorktrees()` on a regular cadence — e.g., every **10–15 minutes** — with a meaningfully shorter age threshold than the current 24-hour default. The minimum 1-hour hard floor should also be reconsidered; a 15–30 minute minimum would allow cleanup to keep up with high-concurrency workloads on containers that may live for only 1–2 hours.

**Why this breaks the causal chain**: With periodic cleanup running inside the worker process, worktree directories that are no longer needed for reuse are reclaimed before they exhaust the ephemeral volume. The ENOSPC condition that caused the lock-file `open()` to fail — and made all retries futile — would not be reached.

### Secondary hardening (defense-in-depth, not the root fix)

1. **ENOSPC detection in `withTerminalVelocityRetry`**: On catching an error with `code === 'ENOSPC'`, attempt an emergency `cleanupOldWorktrees()` call (with a reduced age threshold) before sleeping and retrying. This converts a guaranteed-futile retry loop into a self-healing one when the root-cause fix above has a gap (e.g., very short-lived burst of large repos).

2. **Increase Fargate ephemeral storage**: ECS Fargate allows ephemeral storage up to 200 GB (configurable in the task definition). Increasing the allocation provides a larger buffer for concurrent workloads and buys time for the scheduled cleanup to run.

3. **Disk-usage alerting**: Add a metric/alarm on `/tmp` utilization (e.g., via a periodic `df` call logged as a telemetry gauge) to provide early warning before exhaustion.


---
