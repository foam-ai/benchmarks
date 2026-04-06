[Foam Trace ID: bb284ff15d6410f6b5a4be6400b15125] ## TL;DR

`git worktree add` fails with `fatal: '<path>' already exists` because the code in `git-worktree.service.ts` unconditionally runs `git worktree add` without checking if the target directory already exists from a previous job run, and no cleanup mechanism removes stale worktree directories between runs. The job survives via error handling but falls back to web search instead of analyzing actual code, degrading output quality.

## What Broke and Why

The issue-solver worker processes jobs that require checking out specific commits of customer repositories into git worktrees at `/tmp/tv-worktrees/{customerId}/{owner-repo}/{sha}`. The full causal chain:

**1. Stale worktree directory persists from a prior run.** When a previous job for the same repository (`foam-ai/all-the-things`) and commit (`f175628105d88fb710838e61f5570bbe5734fac5`) completed, its worktree directory at `/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5` was never cleaned up. The codebase contains **zero** cleanup mechanisms — no `git worktree remove`, no `git worktree prune`, no `rm -rf`, no TTL-based cleanup, no startup-phase cleanup.

**2. No pre-existence check before `git worktree add`.** The code in `git-worktree.service.ts` proceeds directly from lock acquisition (line 234) through decision logic (lines 81, 582, 609) to executing `git worktree add` without any `fs.existsSync()` or equivalent check:

```
03:23:57.358 | line 234 | Created file lock: worktree-foam-ai-all-the-things-f175628...lock
03:23:58.218 | line 582 | Creating worktree repo=foam-ai/all-the-things sha=f175628...
03:23:58.241 | line 609 | Git worktree creation method decision: traditional-exec
```

**3. `git worktree add` fails immediately.** Git resolves the commit successfully (`Preparing worktree (detached HEAD f1756281)`) but then discovers the target directory already exists on disk:

```
fatal: '/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5' already exists
```

**4. Lock release timing bug compounds the issue.** The file lock at line 300 is released at `03:23:58.290` — 1ms *before* the `child_process.exec` error callback fires at `03:23:58.291`. This indicates the `exec()` call spawning the git command is not properly awaited within the lock's critical section, so the lock provides no effective concurrency protection even for concurrent requests.

**5. Error is caught but causes degraded behavior.** The exception is marked `handled=true` and the job continues. However, downstream the grep agent tries to search the repo at the worktree path and gets `repo/data: No such file or directory (os error 2)` (the stale directory exists but may not have the expected structure), returning `matchCount=0`. The agent falls back to web search, ultimately producing a report based on web results rather than actual code analysis:

```
03:24:01.804 | ripgrep: repo/data: No such file or directory (os error 2)
03:24:08.021 | grep returns matchCount=0
03:24:22.592 | Agent falls back to webSearch
03:25:36.751 | Run solve completed success=true (degraded quality)
```

**Alternative hypothesis considered and eliminated:** Concurrent processes racing to create the same worktree was considered, but no other worktree operations appear in the 142 log entries for this trace. The simpler explanation — a stale directory from a previous job run — fully explains the error without requiring concurrent traffic.

## Fix

**Primary fix:** Add a pre-existence check before calling `git worktree add` in `git-worktree.service.ts` around line 582. If the directory already exists, either reuse it directly (skip the `git worktree add`) or remove it first and recreate:

```typescript
// Before git worktree add (around line 582):
if (fs.existsSync(worktreePath)) {
  // Worktree already exists from a prior run — reuse it
  logger.info(`Worktree already exists, reusing: ${worktreePath}`);
  return worktreePath;
}
// Proceed with git worktree add...
```

**Secondary fix:** Add post-job cleanup to remove worktree directories after each job completes:

```typescript
// After job completion:
await exec(`git worktree remove "${worktreePath}" --force`);
// Or: await fs.promises.rm(worktreePath, { recursive: true, force: true });
// Followed by: await exec('git worktree prune');
```

**Tertiary fix:** Fix the lock release timing by ensuring the `exec()` call is properly `await`ed within the lock's critical section so the lock at line 300 is not released before the child process completes.

The primary fix breaks the causal chain at step 2: if the code checks for directory existence before calling `git worktree add`, it will never hit the `fatal: already exists` error regardless of whether stale directories exist. The secondary fix prevents stale directory accumulation. The tertiary fix ensures the lock actually protects against concurrent creation.

---
