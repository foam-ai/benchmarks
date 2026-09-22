## TL;DR

`issue-solver.ts:84` hardcodes `body.repoName || 'mewtwo'`, so runs created without a repo name are stored with `repoName = 'mewtwo'`; that repository no longer exists (absorbed into `foam-ai/all-the-things`), so `createWorktree` fails on `git clone --bare`.

## What Broke and Why

**Observed error:** `Error: remote: Repository not found. fatal: repository 'https://github.com/foam-ai/mewtwo.git/' not found`

### Causal Chain

**1.** Affected run documents all have `metadata.repoName = 'mewtwo'`.

**2.** The default predates the repository consolidation.

## Fix

- Remove the default and make `repoName` required in the request schema; backfill affected runs.

---

## Metrics

**Performance:**
- Total latency: 299 seconds
- Token usage: 457,117 + 14,698 = 471,815 tokens

**Tool Usage:**
- Top 3 most-used tools: run_terminal_cmd, list_dir, read_file
- Top 3 most USEFUL tools: read_file (input: the throwing function and its callers) grep (input: the error string across the repo) codebase_search (input: where the failing code path is invoked)
