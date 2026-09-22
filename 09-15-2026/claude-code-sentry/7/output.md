## TL;DR

`getProjectRoot()` in `drain3-pyodide.service.ts` switched to `import.meta.url` with only two `..` segments, resolving to `/app/mewtwo/dist/vendor/drain3` instead of `/app/mewtwo/vendor/drain3`, so Pyodide cannot find `foam_wrapper` on any service or retry.

## What Broke and Why

**Observed error:** `ModuleNotFoundError: No module named 'foam_wrapper' (drain3-pyodide.service.ts)`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The compiled file lives one directory deeper (`dist/services/`) than the source path the traversal was written for.

**2.** Every exception polling job fails identically on every retry — consistent with a static path bug, not a transient issue.

## Fix

- Add one more `..` level (or resolve from the package root via `process.cwd()`/`require.resolve`), as done in PR #333.

---

## Metrics

**Performance:**
- Total latency: 317 seconds
- Token usage: 207,390 + 12,750 = 220,140 tokens

**Tool Usage:**
- Top 3 most-used tools: Read, get_sentry_resource, Glob
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
