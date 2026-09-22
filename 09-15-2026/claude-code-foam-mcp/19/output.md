## TL;DR

`issue-solver.ts:84` hardcodes `body.repoName || 'mewtwo'`, so runs created without a repo name are stored with `repoName = 'mewtwo'`; that repository no longer exists (absorbed into `foam-ai/all-the-things`), so `createWorktree` fails on `git clone --bare`.

## What Broke and Why

**Observed error:** `Error: remote: Repository not found. fatal: repository 'https://github.com/foam-ai/mewtwo.git/' not found`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** Affected run documents all have `metadata.repoName = 'mewtwo'`.

**2.** The default predates the repository consolidation.

## Fix

- Remove the default and make `repoName` required in the request schema; backfill affected runs.

---

## Metrics

**Performance:**
- Total latency: 550 seconds
- Token usage: 506,025 + 6,593 = 512,618 tokens

**Tool Usage:**
- Top 3 most-used tools: query-otel, Grep, Glob
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) Read (input: the throwing function and its callers) Grep (input: the error string across the repo)
