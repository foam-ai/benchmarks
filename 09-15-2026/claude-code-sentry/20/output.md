## TL;DR

Two jobs for the same SHA call `createWorktree()` concurrently; the second sees a half-created worktree and git rejects the duplicate registration.

## What Broke and Why

**Observed error:** `fatal: '<path>' is a missing but already registered worktree; use 'add -f' to override, or 'prune' to clear`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** Two runs reference the same commit within seconds.

**2.** No lock around worktree creation.

## Fix

- Serialise worktree creation per SHA.

---

## Metrics

**Performance:**
- Total latency: 383 seconds
- Token usage: 167,472 + 13,192 = 180,664 tokens

**Tool Usage:**
- Top 3 most-used tools: search_issue_events, Glob, Grep
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
