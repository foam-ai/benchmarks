[Foam Trace ID: 9e11f2421c5aa2ba309b8d6577f9bab6] ## TL;DR

Git worktrees accumulated without cleanup on the issue-solver Fargate task's ephemeral storage over 14.5 hours, exhausting the disk (likely 20 GB default). The scheduled maintenance worker (`cleanupOldWorktrees`) that should remove old worktrees was either not enabled or running on a separate task with its own filesystem. The `ENOSPC` error occurred when creating a lockfile because the entire `/tmp` filesystem was full from accumulated worktrees, not from lockfile leaks.

## What Broke and Why

The Terminal Velocity (TV) system uses git worktrees to check out repositories for code analysis. The `GitWorktreeService` creates worktrees under `/tmp/tv-worktrees/` and base repos under `/tmp/tv-base-repos/`, governed by lockfiles at `/tmp/tv-lockfiles/`:

```typescript
// git-worktree.service.ts — constructor defaults
this.baseRepoDir = '/tmp/tv-base-repos';
this.worktreeDir = '/tmp/tv-worktrees';
this.lockfilesDir = '/tmp/tv-lockfiles';
```

Each unique `{repo}-{sha}` combination creates a separate worktree (a full git working directory checkout, typically 100–500+ MB). Lockfiles are properly released in `finally` blocks after each operation, so lockfiles themselves don't leak.

**The critical design decision**: After each TV job completes, the `cleanup()` method in `terminal-velocity.service.ts` intentionally **preserves worktrees** for reuse optimization:

```typescript
async cleanup(resources) {
    // DO NOT clean up worktree immediately - keep it for reuse
    // Worktrees are only removed by scheduled maintenance after 1 hour
    if (resources.worktreePath) {
        log().debug('Leaving worktree for scheduled cleanup after 1 hour', { worktreePath });
    }
    // Only cleans up prompt files and output directories
}
```

This design relies entirely on a scheduled maintenance worker (`cleanupOldWorktrees`) to evict stale worktrees. The maintenance worker runs if `TV_MAINTENANCE_WORKER_ENABLED=true` is set and operates on a discovery-action queue pattern. **However, the evidence shows maintenance never executed on this task's filesystem during 14.5 hours of uptime** (container booted at `06:11:11`, error at `20:45:42`). Either the env var wasn't enabled for the issue-solver task, or maintenance runs in a separate Fargate task with its own isolated ephemeral storage — in both cases, `cleanupOldWorktrees` never cleaned this task's `/tmp`.

Over those 14.5 hours, the worker continuously processed issue-solver jobs, each creating worktrees that were never removed. The Fargate ephemeral storage (default 20 GB, shared between container image layers and writable data) gradually filled until no space remained.

The final failure occurred when `createWorktree()` called `acquireFileLock()` → `createFileLock()`:

```typescript
const fileHandle = await fs.open(lockPath, 'wx'); // ENOSPC here
```

The `open()` syscall failed with `ENOSPC: no space left on device, open '/tmp/tv-lockfiles/worktree-Stream-claims-backend-1da599c41255134baccc9b84e36709526afb114d.lock'` — the lockfile itself is only a few bytes, but the filesystem had zero free space from accumulated worktrees.

The retry service (`withTerminalVelocityRetry`) then compounded the problem by retrying 3 times with exponential backoff (2s, 4s) without any cleanup between attempts:

```typescript
// terminal-velocity-retry.service.ts — no cleanup, no error classification
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
        const result = await operation();
        return result;
    } catch (error) {
        if (attempt >= maxAttempts) break;
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}
```

All 3 attempts failed identically at `20:45:47`, `20:45:54`, and `20:46:04` — each re-executing the entire pipeline (including redundant LLM calls to Google at 565–819 tokens each) against the same exhausted disk. The retry service has no cleanup hooks, no disk space pre-checks, and no error classification to distinguish ENOSPC from transient errors.

## Fix

**Primary fix — Ensure maintenance runs on the same filesystem as worktree creation:**

1. **Enable the maintenance worker on the issue-solver Fargate task** by setting `TV_MAINTENANCE_WORKER_ENABLED=true` in the ECS task definition environment variables. This ensures `cleanupOldWorktrees` runs in-process on the same ephemeral storage where worktrees accumulate. Alternatively, if the TV worker and issue-solver run in separate tasks, add a shared EFS volume mount for `/tmp/tv-*` directories so maintenance can clean the correct filesystem.

2. **Add proactive disk-pressure cleanup in `GitWorktreeService.createWorktree()`** — before attempting to create a new worktree, check available disk space and trigger `cleanupOldWorktrees` (with a shorter `maxAgeMs`, e.g., 30 minutes) if usage exceeds a threshold (e.g., 80%). This prevents relying solely on scheduled maintenance:

```typescript
async createWorktree(params) {
    const diskUsage = await checkDiskUsage('/tmp');
    if (diskUsage.percentUsed > 80) {
        log().warn('Disk pressure detected, running emergency cleanup');
        await this.cleanupOldWorktrees(30 * 60 * 1000); // 30 min max age
    }
    // ... existing worktree creation logic
}
```

3. **Add ENOSPC handling to the retry service** — classify `ENOSPC` as non-retryable without cleanup, or add a cleanup hook:

```typescript
if (error.code === 'ENOSPC') {
    await gitWorktreeService.cleanupOldWorktrees(0); // emergency: remove all stale
    // Then retry, or throw NonRetryableTerminalVelocityError if cleanup insufficient
}
```

**Why this fixes the root cause:** The root cause is that worktrees accumulate without bound because the maintenance worker doesn't run on the same filesystem. Fix #1 ensures maintenance runs where worktrees live, breaking the accumulation chain. Fix #2 adds a safety net so that even if maintenance is delayed, disk pressure triggers reactive cleanup before ENOSPC. Fix #3 prevents futile retries that waste LLM tokens and wall time without addressing the underlying disk constraint.

---
