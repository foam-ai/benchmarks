## TL;DR

A prior `removeWorktree()` failed and fell through to `forceRemoveWorktreeDirectory()`, which deleted the directory but left git's `.git/worktrees/<name>` registry entry. `createWorktree()` only checks `directoryExists()`, so it proceeds to `git worktree add`, which refuses because the path is still registered.

## What Broke and Why

**Observed error:** `fatal: '<path>' is a missing but already registered worktree; use 'add -f' to override, or 'prune' to clear`

### Causal Chain

**1.** `directoryExists()` returns `false` because the directory is gone.

**2.** Git tracks worktrees in its own registry, independent of the filesystem.

## Fix

- Run `git worktree prune` (or `add -f`) before `git worktree add`, and make `forceRemoveWorktreeDirectory` also prune the registry.

---

## Metrics

**Performance:**
- Total latency: 395 seconds
- Token usage: 251,456 + 23,129 = 274,585 tokens

**Tool Usage:**
- Top 3 most-used tools: Agent, Read, Grep
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
