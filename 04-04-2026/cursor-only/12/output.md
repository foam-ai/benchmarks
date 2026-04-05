## TL;DR
The `/tmp` EBS volume (backing `tv-worktrees`, `tv-base-repos`, `tv-lockfiles`, `tv-outputs`) filled up because **worktree cleanup is never periodically scheduled** in the production TV worker — `performMaintenance()` exists only as a manual CLI command, so worktrees and base repos accumulate indefinitely until `ENOSPC`.

## What Broke and Why

The error `ENOSPC: no space left on device, open '/tmp/tv-lockfiles/worktree-Stream-claims-backend-1da599c41255134baccc9b84e36709526afb...'` occurred when the Terminal Velocity system tried to create a small lockfile during `GitWorktreeService.createWorktree()`. The lockfile itself is tiny (a few bytes of JSON), but the filesystem was completely full, so even this small `fs.open()` call failed.

**Causality chain:**

1. **Issue Solver worker** (`src/workers/issue-solver.worker.ts:33`) receives a job and calls `solveIssue()`.
2. `solveIssue()` delegates to `MiniSolver.solve()` (`src/services/issue-solver/mini-solver.ts:287`), which submits a Terminal Velocity research job to the TV queue.
3. The **TV worker** (`src/workers/terminal-velocity.worker.ts:87`) picks up the job and calls `TerminalVelocityService.processJob()`.
4. `processJob()` calls `GitWorktreeService.createWorktree()` (`src/services/git-worktree.service.ts:606`).
5. `createWorktree()` calls `acquireFileLock()` (line 607), which calls `createFileLock()` (line 231).
6. `createFileLock()` attempts `fs.open(lockPath, 'wx')` (line 241) — this is the `ENOSPC` crash point.
7. The error propagates back through `withTerminalVelocityRetry` (3 retries, all fail since disk is still full), producing the `TerminalVelocityRetryableError`.

**Why the disk filled up — the missing scheduled maintenance:**

The code has a carefully designed maintenance system:
- `TerminalVelocityService.performMaintenance()` (`src/services/terminal-velocity.service.ts:1323`) calls `gitWorktreeService.cleanupOldWorktrees()` which removes worktrees older than a configurable age (default 24h, minimum 1h).
- The `cleanup()` method after each job (`src/services/terminal-velocity.service.ts:1275`) **deliberately does NOT remove worktrees**, commenting: *"DO NOT clean up worktree immediately - keep it for reuse. Worktrees are only removed by scheduled maintenance after 1 hour."*

However, **there is no periodic/scheduled invocation of `performMaintenance()`**:
- The TV worker's `start` command (`src/bin/tv-worker.ts:62`) only calls `startTerminalVelocityWorker()`, which sets up job processing and event handlers — no maintenance scheduling.
- `performMaintenance()` is only reachable via the `yarn tv-worker maintenance` CLI command (`src/bin/tv-worker.ts:83`), which is a one-shot manual operation.
- The in-memory maintenance worker handles individual tasks (touch-worktree, delete-lockfile, git-gc-repo) but has no mechanism to periodically **discover** what needs cleanup.
- There is no cron job, `setInterval`, GitHub Actions workflow, or ECS scheduled task that runs maintenance.
- The ECS task definition (`.github/workflows/.aws/task-definition-tv.json`) only defines the `tv-worker start` command.

In production, all `/tmp/tv-*` paths are backed by EBS volumes (`/mnt/ebs/tv-*`) with finite storage. As jobs run continuously, worktrees accumulate (each can be a full repo checkout), base repos grow (bare clones), and without periodic cleanup, the EBS volume eventually fills completely.

## Fix

**Immediate fix:** Add a periodic `setInterval` in the TV worker's `startTerminalVelocityWorker()` function to schedule maintenance automatically. In `src/workers/terminal-velocity.worker.ts`, inside the `startTerminalVelocityWorker()` function, after the worker and maintenance worker are set up, add:

```typescript
// Schedule periodic maintenance to prevent disk exhaustion
const MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000; // Every 30 minutes
setInterval(async () => {
    try {
        log().info('Running scheduled periodic maintenance');
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
```

**Secondary fix (defense in depth):** Also queue a worktree cleanup job in the `cleanup()` method of `TerminalVelocityService` for writable worktrees (which have unique IDs and cannot be reused), instead of leaving them for maintenance:

```typescript
// In src/services/terminal-velocity.service.ts cleanup() method:
// For writable worktrees, queue immediate cleanup since they can't be reused
if (resources.worktreePath && resources.worktreePath.includes('-writable-')) {
    await this.addMaintenanceJobFn('remove-worktree', {
        type: 'touch-worktree', // reuse existing type
        data: { worktreePath: resources.worktreePath },
        triggeredBy: 'post-job',
    });
}
```

**To recover the currently-full disk**, run the maintenance CLI manually:
```bash
yarn tv-worker maintenance --max-worktree-age 1
```
