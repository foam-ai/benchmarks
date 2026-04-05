## TL;DR
`git worktree add` fails because stale worktree metadata persists in the base repo after `forceRemoveWorktreeDirectory` deletes the directory without running `git worktree prune`.

## What Broke and Why

The error originates in `mewtwo/src/services/git-worktree.service.ts` in the `createWorktree` method (line 638) when it runs:
```
git worktree add "/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5" "f175628105d88fb710838e61f5570bbe5734fac5"
```

The chain of events:

1. **A previous job created this worktree** for the same SHA (`f175628105d88fb710838e61f5570bbe5734fac5`) for customer `674e5380f251f603c5ef1847` on the `foam-ai/all-the-things` repo.

2. **Cleanup partially failed**: When `removeWorktree()` (line 870) was called during cleanup, the `git worktree remove` command at line 907 failed. The catch block (line 911) fell back to `forceRemoveWorktreeDirectory()` (line 851), which only runs `fs.rm(worktreePath, { recursive: true, force: true })` — this removes the **directory** but leaves git's **internal worktree metadata** intact in the base repo at `.git/worktrees/f175628105d88fb710838e61f5570bbe5734fac5/`.

3. **New job for the same SHA arrives**: `createWorktree()` checks `directoryExists(worktreePath)` at line 586, which returns `false` (directory was force-deleted). So it enters the "create new worktree" branch.

4. **Git rejects the operation**: `git worktree add` discovers the stale metadata entry in `.git/worktrees/` and throws `fatal: '/tmp/tv-worktrees/...' is already registered as a worktree`. Git refuses to create a worktree at a path that's already tracked in its internal state, even though the physical directory no longer exists.

**Root cause**: The codebase has **zero calls to `git worktree prune`** — the git command specifically designed to clean up stale worktree entries when the directory has been manually removed. The `forceRemoveWorktreeDirectory` fallback deletes the filesystem directory but never cleans up git's internal metadata, creating a "ghost" worktree registration that blocks all future worktree creation at that path.

The `useDockerGitOperations` flag is `false` for this customer (the traditional `execAsync` path is used), so this is the non-Docker code path at line 638.

## Fix

**Primary fix** — Add `git worktree prune` before `git worktree add` in the `createWorktree` method (around line 635):

```typescript
// Prune stale worktree entries before creating new one
// This cleans up metadata left by force-removed worktrees
if (shouldUseDocker) {
    const dockerGitService = this.createDockerGitService(customerId);
    await dockerGitService.executeGitCommand(['worktree', 'prune'], {
        cwd: baseRepo,
        timeout: 30000,
    });
} else {
    await execAsync('git worktree prune', {
        cwd: baseRepo,
        timeout: 30000,
    });
}

// Then proceed with git worktree add
```

**Secondary fix** — Also add pruning to the `forceRemoveWorktreeDirectory` fallback so stale metadata is cleaned up at the source (line 851-865). This requires passing the base repo path to the method:

```typescript
private async forceRemoveWorktreeDirectory(
    worktreePath: string,
    baseRepoPath: string | undefined,
    originalError: unknown,
): Promise<void> {
    await fs.rm(worktreePath, { recursive: true, force: true });
    log().info('Manually removed worktree directory', { worktreePath });

    // Clean up stale git worktree metadata
    if (baseRepoPath) {
        await execAsync('git worktree prune', { cwd: baseRepoPath, timeout: 30000 });
        log().info('Pruned stale worktree metadata', { baseRepoPath });
    }
}
```

Both fixes together provide defense-in-depth: the secondary fix prevents stale metadata from accumulating, while the primary fix handles any pre-existing stale entries.

---
