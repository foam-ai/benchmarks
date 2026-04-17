[Foam Trace ID: a51214e3bf6d309a35d1f05fa2b9cc50] ## TL;DR

`git worktree add` failed because a previous worktree for commit `f175628105d88fb710838e61f5570bbe5734fac5` was registered in git's internal `.git/worktrees/` registry but its on-disk directory had been deleted (most likely by an ECS task restart or container recycle clearing `/tmp`). The service attempted to re-create the worktree without first pruning stale registrations, causing git to refuse with `fatal: '...' is a missing but already registered worktree`. The fix is to run `git worktree prune` on the base repository before each `git worktree add` attempt.

## What Broke and Why

### The Full Causal Chain

**1. Root cause — stale worktree registration from a prior run**

Git maintains an internal registry of all linked worktrees under the base repository's `.git/worktrees/` directory. When a worktree directory is removed by means other than `git worktree remove` (e.g., `rm -rf`, a container restart wiping `/tmp`), the `.git/worktrees/` entry persists. This produces what git calls the "missing but already registered" state.

The service runs on AWS ECS EC2 and stores:
- Base repositories at `/tmp/tv-base-repos/<owner>/<repo>` (persistent across job runs on the same host)
- Worktrees at `/tmp/tv-worktrees/<customerId>/<repo>/<sha>` (also under `/tmp`, but evidently cleared more aggressively — e.g., on task restarts or container recycles)

A prior run for commit `f175628105d88fb710838e61f5570bbe5734fac5` had created and then lost the worktree directory at `/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5`. The base repo at `/tmp/tv-base-repos/foam-ai/all-the-things` — which holds the `.git/worktrees/` registry — survived (it was found locally valid and fetched successfully at `03:23:57.379`). The worktree directory, however, was gone.

**2. No pre-flight pruning before worktree creation**

In `git-worktree.service.ts`, the setup sequence (confirmed by span logs) is:
1. Validate/fetch base repo at `/tmp/tv-base-repos/foam-ai/all-the-things` ✅ (`03:23:57.379`–`03:23:58.217`)
2. Verify SHA `f175628105d88fb710838e61f5570bbe5734fac5` exists in repo ✅ (`03:23:58.240`)
3. Choose exec method: `traditional-exec` ✅ (`03:23:58.241`)
4. Execute `git worktree add "/tmp/tv-worktrees/.../f175628105..." "f175628105..."` ❌ (`03:23:58.285`)

**No step runs `git worktree prune`** or checks for stale worktree registrations before step 4. The service's pre-flight checks only verify that the SHA exists and the repo is accessible — they do not account for the case where git's registry references a now-deleted path.

**3. Git rejects the add immediately**

When git executes `worktree add`, it detects the existing (stale) registry entry and aborts before creating anything:

```
Command failed: git worktree add "/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5" "f175628105d88fb710838e61f5570bbe5734fac5"
Preparing worktree (detached HEAD f1756281)
fatal: '/tmp/tv-worktrees/674e5380f251f603c5ef1847/foam-ai-all-the-things/f175628105d88fb710838e61f5570bbe5734fac5' is a missing but already registered worktree;
use 'add -f' to override, or 'prune' or 'remove' to clear
```

Git itself surfaces the exact remediation: `prune` or `add -f`.

**4. Two error spans, one failure**

Spans `s75` (`03:23:58.285`) and `s76 / 8c505da10053255c` (`03:23:58.291`) represent the same underlying exec failure recorded at two levels of the call stack in `git-worktree.service.ts` — the inner `child_process.exec` error and the outer service method error. This is not a retry loop; it is a single failed attempt surfaced twice through the error-handling chain.

**Why `/tmp` diverges between base repos and worktrees**

The base repository at `/tmp/tv-base-repos/` persists across ECS task restarts on the same EC2 host instance (or is re-cloned on first miss), so it retains `.git/worktrees/` entries. The per-job worktree directories at `/tmp/tv-worktrees/` appear to be cleaned up more aggressively (e.g., by the job's own teardown logic on certain exit paths, or by OS-level `/tmp` pruning), causing the directory-registry mismatch.

## Fix

**Run `git worktree prune` on the base repository immediately before each `git worktree add` call** in `git-worktree.service.ts`.

```ts
// In git-worktree.service.ts, just before the worktree add:
await exec(`git -C "${baseRepoPath}" worktree prune`);
await exec(`git -C "${baseRepoPath}" worktree add "${worktreePath}" "${gitSha}"`);
```

`git worktree prune` removes all registry entries whose on-disk directories are missing, atomically clearing the stale registration before the add is attempted. This directly breaks the causal chain at the root: after pruning, git's registry has no entry for the missing path, so the subsequent `worktree add` succeeds as if the prior run never happened.

**Why this is sufficient:** The error is triggered deterministically by the stale registry entry. Pruning removes that entry before each add. Even if the worktree directory was deleted in any manner (task restart, explicit cleanup, OS pruning), the next job run will successfully create a fresh worktree. No other code path can reach the `fatal: missing but already registered` error once prune runs first.

**Alternative (also valid):** Use `git worktree add --force` (`add -f`), which git itself suggests. This is slightly more permissive (it will overwrite even intentionally-locked registrations), so `prune` is the more conservative and correct choice.

**Optional enhancement (not a fix):** Ensure the job's teardown path always calls `git worktree remove --force` (or `git worktree prune`) rather than `rm -rf` on the worktree directory, so the registry stays in sync proactively. This prevents the stale state from accumulating in the first place, but the `prune`-before-add fix is sufficient to make the system self-healing.


---
