## TL;DR

A prior `removeWorktree()` failed and fell through to `forceRemoveWorktreeDirectory()`, which deleted the directory but left git's `.git/worktrees/<name>` registry entry. `createWorktree()` only checks `directoryExists()`, so it proceeds to `git worktree add`, which refuses because the path is still registered.

## What Broke and Why

**Observed error:** `fatal: '<path>' is a missing but already registered worktree; use 'add -f' to override, or 'prune' to clear`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** `directoryExists()` returns `false` because the directory is gone.

**2.** Git tracks worktrees in its own registry, independent of the filesystem.

## Fix

- Run `git worktree prune` (or `add -f`) before `git worktree add`, and make `forceRemoveWorktreeDirectory` also prune the registry.

---

## Metrics

**Performance:**
- Total latency: 323 seconds
- Token usage: 446,666 + 10,722 = 457,388 tokens

**Tool Usage:**
- Top 3 most-used tools: grep, query-otel, codebase_search
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) read_file (input: the throwing function and its callers) grep (input: the error string across the repo)
