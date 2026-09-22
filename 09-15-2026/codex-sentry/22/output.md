## TL;DR

A minor version bump of the `ai` package changed how tool results are parsed; the new version assumes text results and crashes on structured output.

## What Broke and Why

**Observed error:** `TypeError: text2.match is not a function (ai/dist/index.mjs)`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The stack trace is inside `ai/dist/index.mjs`.

**2.** The lockfile shows a recent `ai` upgrade.

## Fix

- Pin `ai` to the previous version.

---

## Metrics

**Performance:**
- Total latency: 489 seconds
- Token usage: 459,403 + 10,213 = 469,616 tokens

**Tool Usage:**
- Top 3 most-used tools: search_issue_events, update_plan, read_file
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
