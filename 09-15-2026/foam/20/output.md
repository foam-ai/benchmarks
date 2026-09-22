[Foam Trace ID: 7b0af666dc2ab00e9fb41f18b3724cb7] ## TL;DR

A prior `removeWorktree()` failed and fell through to `forceRemoveWorktreeDirectory()`, which deleted the directory but left git's `.git/worktrees/<name>` registry entry. `createWorktree()` only checks `directoryExists()`, so it proceeds to `git worktree add`, which refuses because the path is still registered.

## What Broke and Why

**Observed error:** `fatal: '<path>' is a missing but already registered worktree; use 'add -f' to override, or 'prune' to clear`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** `directoryExists()` returns `false` because the directory is gone.

**2.** Git tracks worktrees in its own registry, independent of the filesystem.

## Fix

- Run `git worktree prune` (or `add -f`) before `git worktree add`, and make `forceRemoveWorktreeDirectory` also prune the registry.


---
