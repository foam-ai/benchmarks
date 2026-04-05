## TL;DR

`git worktree add` failed with `fatal: '...' is a missing but already registered worktree` because the filesystem directory at `/tmp/tv-worktrees/.../f175628105d88fb710838e61f5570bbe5734fac5` had been previously deleted without cleaning up git's internal worktree registry in `.git/worktrees/`. The `createWorktree()` method in `git-worktree.service.ts` has no `git worktree prune` step or retry-after-prune logic, so stale metadata causes an unrecoverable fatal error. The fix is to run `git worktree prune` on the base repo before `git worktree add`, or catch the "already registered" error and retry after pruning.

## What Broke and Why

The failure originates in the worktree lifecycle management in `mewtwo/src/services/git-worktree.service.ts`.

**Step 1 — Stale metadata created by incomplete cleanup.** When a worktree is removed, the `removeWorktree()` method first attempts `git worktree remove`, but if that fails (locked files, Docker issues, etc.), it falls back to `forceRemoveWorktreeDirectory()`:

```typescript
private async forceRemoveWorktreeDirectory(worktreePath: string, originalError: unknown): Promise<void> {
    await fs.rm(worktreePath, { recursive: true, force: true });
    // Only deletes the directory — does NOT clean up .git/worktrees/<name>/ metadata
}
```

This deletes the worktree directory on disk but leaves git's internal worktree registry (`.git/worktrees/<sha>/gitdir`) intact in the base repo at `/tmp/tv-base-repos/foam-ai/all-the-things`. The same stale metadata can also be left behind by ECS container restarts or `/tmp` cleanup that removes worktree directories without running `git worktree remove`.

**Step 2 — New worktree creation hits stale registration.** On 2026-01-20 at 03:23:57Z, issue-solver job #1733 was triggered via `POST /issue-solver/foam-issue/trigger` for customer `674e5380f251f603c5ef1847`. The `SimpletonAgent` invoked the `executeCommands` tool, which called `createWorktree()` for SHA `f175628105d88fb710838e61f5570bbe5734fac5`. The method:

1. **Acquired the file lock** at `/tmp/tv-lockfiles/worktree-foam-ai-all-the-things-f175628105d88fb710838e61f5570bbe5734fac5.lock` ✅
2. **Checked `directoryExists(worktreePath)`** → returned `false` (the directory was gone) 
3. **Verified SHA exists** via `git cat-file -e` ✅
4. **Executed `git worktree add`** via the traditional-exec path:

```typescript
await execAsync(`git worktree add "${worktreePath}" "${gitSha}"`, {
    cwd: baseRepo,
    timeout: 60000,
});
```

Git started preparing the worktree (`Preparing worktree (detached HEAD f1756281)`) but then found the stale registration and aborted:

```
fatal: '/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5' 
is a missing but already registered worktree;
use 'add -f' to override, or 'prune' or 'remove' to clear
```

**Step 3 — No recovery logic.** The `catch` block only captures the exception to Sentry and re-throws — there is no `git worktree prune`, no `--force` retry, and no stale metadata cleanup:

```typescript
} catch (error) {
    Sentry.captureException(error, { extra: { repoOwner, repoName, gitSha, customerId } });
    foam.captureException(error);
    throw error;  // no recovery
} finally {
    await this.releaseFileLock(lockPath);
}
```

The two error spans visible in telemetry (at 03:23:58.285 and 03:23:58.291, spanIds `7ed229ba` and `8c505da1`) are the same error captured twice — once by `Sentry.captureException()` and once by `foam.captureException()` — not two separate attempts. The overall job ultimately succeeded (logged `success=true` at 03:25:36), likely because a subsequent `executeCommands` retry found the worktree through a different path.

**Alternative hypothesis considered and eliminated:** A cross-host race condition (two ECS instances concurrently creating the same worktree) was considered but ruled out. The file lock was properly acquired and held throughout the operation; the two error spans are from dual exception capture in the same catch block, not concurrent requests. The root cause is deterministically stale git metadata, not a timing-dependent race.

A post-incident fix was applied in commit `2ad0d95` ([FOA-1635], 2026-01-29) which added session-tracking markers to prevent *premature worktree cleanup* — but this fix does **not** add `git worktree prune` before `git worktree add`, does **not** fix `forceRemoveWorktreeDirectory()` to clean up git metadata, and does **not** add retry logic for the "already registered" error. The stale metadata failure mode remains possible.

## Fix

Add a `git worktree prune` call in `createWorktree()` before executing `git worktree add`, and add a catch-and-retry mechanism for the "already registered" error:

```typescript
// In createWorktree(), before the git worktree add call:
await execAsync('git worktree prune', { cwd: baseRepo, timeout: 10000 });

// Then execute git worktree add as before:
await execAsync(`git worktree add "${worktreePath}" "${gitSha}"`, {
    cwd: baseRepo,
    timeout: 60000,
});
```

Additionally, fix `forceRemoveWorktreeDirectory()` to also clean up git metadata:

```typescript
private async forceRemoveWorktreeDirectory(worktreePath: string, originalError: unknown): Promise<void> {
    try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        // Also prune stale worktree metadata in the base repo
        const baseRepo = this.getBaseRepoPath(worktreePath);
        await execAsync('git worktree prune', { cwd: baseRepo, timeout: 10000 });
    } catch (manualError) { ... }
}
```

**Why this fixes the root cause:** `git worktree prune` removes all worktree registry entries whose directories no longer exist on disk. Running it before `git worktree add` ensures that any stale `.git/worktrees/<name>/` entries left by previous crashes, container restarts, or `forceRemoveWorktreeDirectory()` calls are cleaned up. The `createWorktree()` method already confirmed `directoryExists() === false`, so the prune will clear the exact stale entry that causes the "already registered" fatal error. Fixing `forceRemoveWorktreeDirectory()` prevents new stale entries from being created in the first place.

---