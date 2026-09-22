## TL;DR

`getProjectRoot()` in `drain3-pyodide.service.ts` switched to `import.meta.url` with only two `..` segments, resolving to `/app/mewtwo/dist/vendor/drain3` instead of `/app/mewtwo/vendor/drain3`, so Pyodide cannot find `foam_wrapper` on any service or retry.

## What Broke and Why

**Observed error:** `ModuleNotFoundError: No module named 'foam_wrapper' (drain3-pyodide.service.ts)`

### Causal Chain

**1.** The compiled file lives one directory deeper (`dist/services/`) than the source path the traversal was written for.

**2.** Every exception polling job fails identically on every retry — consistent with a static path bug, not a transient issue.

## Fix

- Add one more `..` level (or resolve from the package root via `process.cwd()`/`require.resolve`), as done in PR #333.

---

## Metrics

**Performance:**
- Total latency: 478 seconds
- Token usage: 288,517 + 17,400 = 305,917 tokens

**Tool Usage:**
- Top 3 most-used tools: codebase_search, grep, run_terminal_cmd
- Top 3 most USEFUL tools: read_file (input: the throwing function and its callers) grep (input: the error string across the repo) codebase_search (input: where the failing code path is invoked)
