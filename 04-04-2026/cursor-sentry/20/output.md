## TL;DR
`createWorktree` reuses a worktree directory without validating the `.git` file exists, so when a previous operation left a directory in a corrupted state (directory exists but `.git` file is missing), `fixWorktreeGitFile` crashes with ENOENT.

## What Broke and Why

The error is `ENOENT: no such file or directory, open '/tmp/tv-worktrees/.../7e6da11b.../.git'` thrown from `GitWorktreeService.fixWorktreeGitFile` at line 110 of `git-worktree.service.ts`.

**Causality chain:**

1. **Worktree reuse check is incomplete**: In `createWorktree` (line 586), the code checks whether the worktree directory exists via `this.directoryExists(worktreePath, customerId)`. This method only calls `fs.stat(dirPath)` and `stat.isDirectory()` — it verifies the **directory** exists, but does NOT verify the worktree is **valid** (i.e., has a `.git` file inside it).

2. **Corrupted worktree directory exists**: A previous `git worktree add` operation (line 638) likely failed or timed out (60s timeout) after creating the worktree directory but before git could write the `.git` file inside it. When this happens, the `catch` block at line 663 reports the error to Sentry and re-throws, but **never cleans up the partially-created directory**. The directory persists on disk in a corrupted state.

3. **Reuse skips creation**: On the next attempt, `directoryExists` returns `true` (line 586), so the code sets `worktreeWasReused = true` (line 592) and skips the entire worktree creation block (lines 593-642). It proceeds directly to `fixWorktreeGitFile` (line 653).

4. **ENOENT crash**: `fixWorktreeGitFile` constructs `gitFilePath = path.join(worktreePath, '.git')` (line 100) and, since `shouldUseDockerGitOperations` returns `false` (the service is constructed with defaults via `new GitWorktreeService()` in `execute-commands.tool.ts:89`), takes the direct filesystem branch at line 110: `await fs.readFile(gitFilePath, 'utf8')`. Since the `.git` file was never created, this throws ENOENT.

5. **77 occurrences**: Once a worktree directory is left corrupted, **every subsequent attempt** to use that same repo+SHA combination hits the same ENOENT error, because the corrupted directory is never cleaned up. This explains the 77 occurrences over the Jan 22–29 window.

The Sentry breadcrumbs confirm this flow exactly: the logs show "Worktree already exists, touching and reusing" immediately followed by "Fixing worktree .git file paths for container mounting" and then the crash.

## Fix

Validate that the `.git` file exists when reusing a worktree. If the worktree directory exists but is missing its `.git` file, treat it as corrupted — remove it and recreate from scratch.

In `createWorktree`, replace the simple directory existence check with a validity check:

```typescript
// Check if worktree already exists AND is valid
let worktreeWasReused = false;
if (await this.directoryExists(worktreePath, customerId)) {
    // Validate the worktree is complete by checking for .git file
    const gitFilePath = path.join(worktreePath, '.git');
    let isValidWorktree = false;

    if (this.shouldUseDockerGitOperations(customerId)) {
        const dockerGitService = this.createDockerGitService(customerId);
        try {
            await dockerGitService.readFile(gitFilePath);
            isValidWorktree = true;
        } catch {
            isValidWorktree = false;
        }
    } else {
        try {
            await fs.access(gitFilePath);
            isValidWorktree = true;
        } catch {
            isValidWorktree = false;
        }
    }

    if (isValidWorktree) {
        log().info('Worktree already exists, touching and reusing', {
            worktreePath,
            gitSha,
        });
        worktreeWasReused = true;
    } else {
        log().warn('Worktree directory exists but is corrupted (missing .git file), removing and recreating', {
            worktreePath,
            gitSha,
        });
        if (this.shouldUseDockerGitOperations(customerId)) {
            const dockerGitService = this.createDockerGitService(customerId);
            await dockerGitService.removeDirectory(worktreePath);
        } else {
            await fs.rm(worktreePath, { recursive: true, force: true });
        }
    }
}
```

Additionally, add cleanup in the `catch` block of `createWorktree` (line 663) to remove partially-created worktree directories on failure, preventing the corrupted state from persisting:

```typescript
} catch (error) {
    Sentry.captureException(error, {
        extra: { repoOwner, repoName, gitSha, customerId: customerId.toString() },
    });
    foam.captureException(error);
    // Clean up partially-created worktree to prevent corrupted reuse
    if (!worktreeWasReused) {
        const worktreePath = path.join(this.worktreeDir, worktreeSubpath);
        try {
            await fs.rm(worktreePath, { recursive: true, force: true });
            log().info('Cleaned up partially-created worktree after error', { worktreePath });
        } catch (cleanupError) {
            log().warn('Failed to clean up partial worktree', { worktreePath, cleanupError });
        }
    }
    throw error;
}
```

---
