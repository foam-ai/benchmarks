## TL;DR

Git's worktree registry is out of sync with the filesystem after a failed removal, so `git worktree add` refuses; a concurrent create for the same SHA may have contributed.

## What Broke and Why

**Observed error:** `fatal: '<path>' is a missing but already registered worktree; use 'add -f' to override, or 'prune' to clear`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** Registry entry survives directory deletion.

**2.** `directoryExists()` is the only guard.

## Fix

- Prune stale registrations before adding; add a per-SHA lock.

---

## Metrics

**Performance:**
- Total latency: 452 seconds
- Token usage: 357,900 + 21,693 = 379,593 tokens

**Tool Usage:**
- Top 3 most-used tools: codebase_search, get_sentry_resource, grep
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) read_file (input: the throwing function and its callers)
