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
- Total latency: 365 seconds
- Token usage: 259,173 + 21,824 = 280,997 tokens

**Tool Usage:**
- Top 3 most-used tools: update_plan, shell, read_file
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
