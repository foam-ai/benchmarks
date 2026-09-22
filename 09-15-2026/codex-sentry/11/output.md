## TL;DR

A job was enqueued to `eval-queue` with empty data `{}`, omitting the required `command` field; the worker validation caught it immediately. Nothing in the code is broken — the job was simply enqueued incorrectly.

## What Broke and Why

**Observed error:** `Error: Invalid eval job data: missing required field 'command'`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The failing job payload in Redis is literally `{}`.

**2.** `EvalJobData` validation runs on dequeue and fails fast.

## Fix

- Fix the producer (manual enqueue / script) to include `command`; optionally validate on `add()` as well.

---

## Metrics

**Performance:**
- Total latency: 568 seconds
- Token usage: 178,959 + 19,536 = 198,495 tokens

**Tool Usage:**
- Top 3 most-used tools: shell, update_plan, get_sentry_resource
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
