[Foam Trace ID: 228c090ec77943befcf1bfef18d44c55] ## TL;DR

`issue-solver.ts:84` hardcodes `body.repoName || 'mewtwo'`, so runs created without a repo name are stored with `repoName = 'mewtwo'`; that repository no longer exists (absorbed into `foam-ai/all-the-things`), so `createWorktree` fails on `git clone --bare`.

## What Broke and Why

**Observed error:** `Error: remote: Repository not found. fatal: repository 'https://github.com/foam-ai/mewtwo.git/' not found`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** Affected run documents all have `metadata.repoName = 'mewtwo'`.

**2.** The default predates the repository consolidation.

## Fix

- Remove the default and make `repoName` required in the request schema; backfill affected runs.


---
