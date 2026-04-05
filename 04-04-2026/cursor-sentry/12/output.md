## TL;DR
The EBS volume shared by all Terminal Velocity data (worktrees, base repos, lockfiles, outputs, Docker images) ran out of disk space because there is no automated/scheduled maintenance — cleanup only runs manually, allowing stale worktrees, repos, and Docker artifacts to accumulate until `ENOSPC` prevents even creating tiny lockfiles.

## What Broke and Why

**The Error Chain:**

1. The **issue-solver worker** (`src/workers/issue-solver.worker.ts:33`) processes a job by calling `solveIssue()`.
2. `solveIssue()` (`src/services/issue-solver/index.ts:121`) invokes `runIssueSolver()` wrapped in `withTerminalVelocityRetry` with 3 max attempts.
3. `runIssueSolver()` (`src/services/issue-solver/index.ts:40-114`) uses the **MiniSolver** (feature-flagged), which submits a Terminal Velocity job to a BullMQ queue.
4. The **TV worker** picks up the job and calls `TerminalVelocityService.processJob()` → `GitWorktreeService.createWorktree()`.
5. `createWorktree()` (`src/services/git-worktree.service.ts:606-607`) calls `acquireFileLock('worktree-{owner}-{repo}-{sha}')`.
6. `acquireFileLock()` → `createFileLock()` (`src/services/git-worktree.service.ts:231-232`) calls `fs.mkdir()` to ensure the lockfiles directory exists, then `fs.open(lockPath, 'wx')` to atomically create the lock file.
7. **`fs.open()` fails with `ENOSPC: no space left on device`** because the underlying filesystem is completely full.
8. This error propagates up through the MiniSolver as `"Mini-Solver Terminal Velocity job failed: ENOSPC: no space left on device, open '/tmp/tv-lockfiles/worktree-...'"`.
9. `withTerminalVelocityRetry` retries 3 times with exponential backoff (2s, 4s base delays), but all attempts fail because the disk is still full — **retrying doesn't free disk space**.
10. After 3 failed attempts, `createTerminalVelocityRetryableError()` throws the final `TerminalVelocityRetryableError`.

**Why the Disk Filled Up:**

The Terminal Velocity infrastructure uses a single EBS volume (`/mnt/ebs`, provisioned as a 1TB XFS filesystem in `scripts/tv-ec2-userdata.sh:30-33`) that stores:
- `/mnt/ebs/tv-worktrees` — git worktrees for each job (can be hundreds of MB each)
- `/mnt/ebs/tv-base-repos` — bare clones of customer repositories (can be GBs each)
- `/mnt/ebs/tv-lockfiles` — coordination lockfiles (tiny, but can't be created when disk is full)
- `/mnt/ebs/tv-outputs` — job output artifacts
- `/mnt/ebs/docker` — Docker data root (images, containers, layers)

These are mounted into ECS containers at `/tmp/tv-*` paths via the task definition (`task-definition-tv.json:9-25`).

**The critical missing piece: there is no automated/scheduled maintenance.** The `performMaintenance()` method exists (`src/services/terminal-velocity.service.ts:1323`) and can clean up old worktrees, lockfiles, and run git gc, but:
- The TV worker process (`src/bin/tv-worker.ts`) only calls maintenance when explicitly invoked via CLI (`yarn tv-worker maintenance`)
- The `startTerminalVelocityWorker()` function in `src/workers/terminal-velocity.worker.ts` sets up no periodic maintenance — only a spot-instance interruption check runs on `setInterval` (line 659)
- The in-memory maintenance queue only processes jobs added to it (touch-worktree, post-job cleanup), but nobody schedules the discovery/cleanup sweep

Over time, worktrees accumulate (default 24h retention, minimum 1h), base repos grow with fetches, Docker images pile up, and output directories linger until the 1TB volume is exhausted.

**Additional contributing factors:**
- `createFileLock()` (`src/services/git-worktree.service.ts:254-268`) only handles `EEXIST` errors — `ENOSPC` is treated as an unexpected error and thrown immediately
- The retry mechanism (`withTerminalVelocityRetry`) blindly retries the same failing operation without attempting to free disk space
- No disk space pre-check exists before creating worktrees or lockfiles
- The worker concurrency (`TV_QUEUE_CONCURRENCY`, defaulting to 1 in keys.ts:248) limits throughput but doesn't prevent disk accumulation over days/weeks

## Fix

### Immediate Fix: Add scheduled periodic maintenance to the TV worker

In `src/workers/terminal-velocity.worker.ts`, add a `setInterval` in `startTerminalVelocityWorker()` that periodically runs `performMaintenance()`:

```typescript
// In startTerminalVelocityWorker(), after starting the maintenance worker:

// Schedule periodic maintenance every 2 hours
const MAINTENANCE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const maintenanceInterval = setInterval(async () => {
    try {
        log().info('Running scheduled Terminal Velocity maintenance');
        const service = new TerminalVelocityService();
        await service.performMaintenance({
            maxWorktreeAgeMs: 2 * 60 * 60 * 1000, // 2 hours
            performGitGc: true,
            cleanupLockfiles: true,
        });
    } catch (error) {
        log().error('Scheduled maintenance failed', {
            error: error instanceof Error ? error.message : String(error),
        });
        Sentry.captureException(error);
    }
}, MAINTENANCE_INTERVAL_MS);

// Run initial maintenance on startup after a brief delay
setTimeout(async () => {
    try {
        const service = new TerminalVelocityService();
        await service.performMaintenance({
            maxWorktreeAgeMs: 2 * 60 * 60 * 1000,
            performGitGc: true,
            cleanupLockfiles: true,
        });
    } catch (error) {
        Sentry.captureException(error);
    }
}, 30000); // 30 seconds after startup
```

### Secondary Fix: Add ENOSPC handling in `createFileLock`

In `src/services/git-worktree.service.ts`, in the `createFileLock` method's catch block (line 254), add handling for `ENOSPC` alongside the existing `EEXIST` handler:

```typescript
} catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        // ... existing EEXIST handling ...
    } else if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOSPC') {
        log().error('ENOSPC: No space left on device while creating lockfile, triggering emergency cleanup', {
            lockPath,
            attempt,
        });
        Sentry.captureException(error, {
            tags: { operation: 'lockfile_creation_enospc' },
            extra: { lockPath, attempt },
        });
        // Attempt emergency cleanup of old lockfiles and worktrees
        await this.cleanupOldLockfiles();
        continue; // Retry after cleanup
    }
    throw error;
}
```

### Tertiary Fix: Add disk space monitoring

Add a utility that checks disk space before resource-intensive operations (worktree creation) and proactively triggers maintenance when usage exceeds a threshold (e.g., 85%).

---
