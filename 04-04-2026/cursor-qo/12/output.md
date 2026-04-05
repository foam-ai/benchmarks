## TL;DR
Terminal Velocity worker exhausted `/tmp` disk space due to accumulated git worktrees and bare repos with no automatic periodic maintenance, causing `ENOSPC` when creating lockfiles.

## What Broke and Why

The `TerminalVelocityRetryableError` at `2025-12-24 20:46:04` was thrown by the Issue Solver (runId `3daa8451-d9fa-4b72-b3f5-82e880115e76`) after 3 retry attempts, each failing with `ENOSPC: no space left on device` when trying to open `/tmp/tv-lockfiles/worktree-Stream-claims-backend-1da599c41255134baccc9b84e36709526afb114d.lock`.

**Error chain:**
1. `git-worktree.service.ts:createFileLock()` (line 241) calls `fs.open(lockPath, 'wx')` to atomically create a lockfile
2. The OS returns `ENOSPC` because the `/tmp` partition is full
3. This propagates up through `createWorktree()` → `processJob()` in `terminal-velocity.service.ts`
4. The MiniSolver catches the TV job failure at `mini-solver.ts:323` and re-throws
5. `withTerminalVelocityRetry()` in `terminal-velocity-retry.service.ts` retries 3 times with exponential backoff — but since the underlying issue is disk-full, all retries fail identically
6. The final `TerminalVelocityRetryableError` is thrown and the issue-solver worker marks Job 127988 as failed

**Root cause — no automatic disk space management:**

The Terminal Velocity system stores three categories of data in `/tmp`:
- **`/tmp/tv-base-repos`**: Bare git clones of customer repositories (can be hundreds of MB to GBs each)
- **`/tmp/tv-worktrees`**: Full checkout worktrees per repo/SHA (similar size to repos)
- **`/tmp/tv-lockfiles`**: Small lockfiles for mutex coordination

The `performMaintenance()` method in `terminal-velocity.service.ts` (line 1323) handles cleanup of all three, but it is **never called automatically on a schedule**. It is only invoked:
1. Manually via `yarn tv-worker maintenance` CLI command (`tv-worker.ts:83`)
2. There is no `setInterval`, cron, or periodic scheduling anywhere in the worker code

Meanwhile, the TV worker processes jobs at high concurrency (`TV_QUEUE_CONCURRENCY` defaults to 30), continuously cloning repos and creating worktrees. Worktrees are deliberately kept for reuse with a **1-hour minimum age** before cleanup eligibility (line 866 of `git-worktree.service.ts`). Without periodic maintenance running, these accumulate indefinitely.

**This is a recurring issue** — telemetry shows identical ENOSPC failures on 2025-11-20, 2025-11-21, and 2025-12-24 across multiple customers (Stream, GPTZero, MAZLO-INC, togethercomputer). The disk fills up, all TV jobs fail across all customers until someone manually runs maintenance or the instance is replaced.

**Contributing factors:**
- The maintenance worker (`TV_MAINTENANCE_WORKER_ENABLED`) only processes queued jobs — it doesn't schedule them. No code calls `performMaintenance()` periodically.
- Lockfile cleanup only cleans files >5 minutes old, but the **disk is full** — the lockfiles themselves are tiny; the real space consumers are base repos and worktrees.
- No disk space pre-check before `fs.open()` — the system doesn't fail gracefully or trigger emergency cleanup when disk is critically low.

## Fix

**Immediate fix — Add periodic maintenance scheduling to the TV worker:**

In `src/workers/terminal-velocity.worker.ts`, add a maintenance interval inside `startTerminalVelocityWorker()`:

```typescript
// After starting the maintenance worker, schedule periodic maintenance
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000; // Every 15 minutes
const maintenanceInterval = setInterval(async () => {
    try {
        const service = new TerminalVelocityService();
        await service.performMaintenance({
            maxWorktreeAgeMs: 2 * 60 * 60 * 1000, // 2 hours
            performGitGc: true,
            cleanupLockfiles: true,
        });
    } catch (error) {
        log().error('Scheduled maintenance failed', { error });
        Sentry.captureException(error);
    }
}, MAINTENANCE_INTERVAL_MS);
```

**Additional hardening:**

1. **Add disk space pre-check in `createFileLock()`** — before attempting `fs.open()`, check available disk space with `fs.statfs()` and trigger emergency cleanup if below a threshold (e.g., 1GB):

```typescript
private async checkDiskSpace(): Promise<void> {
    const stats = await fs.statfs(this.lockfilesDir);
    const availableBytes = stats.bavail * stats.bsize;
    const threshold = 1024 * 1024 * 1024; // 1GB
    if (availableBytes < threshold) {
        log().warn('Low disk space detected, triggering emergency cleanup', {
            availableBytes,
            threshold,
        });
        await this.cleanupOldWorktrees(60 * 60 * 1000); // Clean worktrees >1hr
        await this.cleanupOldLockfiles();
    }
}
```

2. **Reduce worktree retention from 1 hour to 30 minutes** for scheduled maintenance runs, since 1 hour is aggressive for a high-concurrency worker.

3. **Add a disk space health check** in `healthCheck()` to surface `degraded` status when disk is >80% full, enabling alerting before total failure.

---
