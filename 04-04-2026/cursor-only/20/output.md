## TL;DR
`forceRemoveWorktreeDirectory` deletes the worktree directory but leaves stale git metadata in the bare repo's `.git/worktrees/` directory, causing subsequent `git worktree add` calls for the same path to fail because git still tracks the orphaned entry.

## What Broke and Why

The failure chain is:

1. **Previous worktree removal failed gracefully**: At some earlier point, `removeWorktree()` was called for this customer/repo/SHA combination. The `git worktree remove` command failed (e.g., dirty worktree, locked files, or corrupted state). The catch block at line 911 in `git-worktree.service.ts` caught the error and fell back to `forceRemoveWorktreeDirectory()`.

2. **Force-remove only deleted the directory, not git metadata**: `forceRemoveWorktreeDirectory()` (line 851) calls `fs.rm(worktreePath, { recursive: true, force: true })`, which removes the worktree directory at `/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5`. However, it does **not** clean up the corresponding git worktree tracking entry stored in the bare repository at `/tmp/tv-base-repos/foam-ai/all-the-things/worktrees/f175628105d88fb710838e61f5570bbe5734fac5/`. This tracking directory contains `gitdir`, `HEAD`, and `commondir` files that git uses to manage the worktree relationship.

3. **New worktree creation hit stale metadata**: When a new request arrived for the same SHA, `createWorktree()` ran `directoryExists()` which returned false (the directory was gone). But when `git worktree add` executed (line 638), git found the orphaned worktree tracking entry in the bare repo and refused to create the worktree, producing: `fatal: '/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5' already exists` (referring to the metadata entry, not the directory).

The codebase never calls `git worktree prune` anywhere — confirmed by searching for `worktree prune` across the entire repo and finding zero results. This means stale worktree entries accumulate permanently in bare repos whenever the force-remove fallback path is taken.

## Fix

Run `git worktree prune` on the base repo before attempting `git worktree add` to clean up any orphaned worktree entries. In `git-worktree.service.ts`, add the prune step inside the `createWorktree` method, right before the `git worktree add` call (around line 635):

```typescript
// Prune stale worktree entries before adding new one
// This cleans up orphaned metadata from previous force-removed worktrees
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
```

This should be inserted at line 635, just before the Docker/exec branching for `git worktree add` (lines 617-642).

Additionally, to make the force-remove fallback more robust, `forceRemoveWorktreeDirectory` should also attempt to prune git metadata after removing the directory. Update `forceRemoveWorktreeDirectory` (line 851) to also run `git worktree prune` on the base repo:

```typescript
private async forceRemoveWorktreeDirectory(
    worktreePath: string,
    originalError: unknown,
    baseRepoPath?: string,
): Promise<void> {
    try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        log().info('Manually removed worktree directory', { worktreePath });

        // Clean up stale git metadata for the removed worktree
        if (baseRepoPath) {
            await execAsync('git worktree prune', {
                cwd: baseRepoPath,
                timeout: 30000,
            });
            log().info('Pruned stale worktree entries after force removal', { baseRepoPath });
        }
    } catch (manualError) {
        Sentry.captureException(manualError, {
            extra: { worktreePath, originalError },
        });
        foam.captureException(manualError);
        throw manualError;
    }
}
```

The `baseRepoPath` is already computed in `removeWorktree` (line 896: `const baseRepo = path.dirname(gitDir)`) and should be passed through to `forceRemoveWorktreeDirectory` at the catch-block call site (line 923).
