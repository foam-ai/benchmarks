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
- Total latency: 217 seconds
- Token usage: 401,696 + 13,682 = 415,378 tokens

**Tool Usage:**
- Top 3 most-used tools: Grep, Bash, Glob
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
