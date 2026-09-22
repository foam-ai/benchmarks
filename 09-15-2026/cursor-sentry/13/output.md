## TL;DR

The `git` binary is missing from the ECS worker image, so pre-flight checks fail; the 2-hour timeout is a secondary symptom of the missing failure propagation.

## What Broke and Why

**Observed error:** `Error: Working directory is not clean (git-operations.ts) ... Job timed out after 7200000ms`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** `git` commands fail inside the container.

**2.** The job stays active until the timeout.

## Fix

- Install git in the image and fail fast on pre-flight errors.

---

## Metrics

**Performance:**
- Total latency: 266 seconds
- Token usage: 331,295 + 9,381 = 340,676 tokens

**Tool Usage:**
- Top 3 most-used tools: get_sentry_resource, read_file, codebase_search
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) read_file (input: the throwing function and its callers)
