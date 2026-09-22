## TL;DR

The `bubblesModel` fallback chain exhausted `CLAUDE_SONNET_4` and `CLAUDE_HAIKU_45` and fell through to `CLAUDE_SONNET_37`, which is routed to Vertex AI; project `foam-ai-452314` has no entitlement to that deprecated model, Vertex returns 404, and `FallbackModel.retry` treats 404 as retryable and loops.

## What Broke and Why

**Observed error:** `404 NOT_FOUND: Publisher Model `claude-3-7-sonnet@20250219` was not found`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** `ANTHROPIC_TO_VERTEX` still maps Sonnet 3.7 even though it was deprecated in Nov 2025 for new customers.

**2.** 404 is classified alongside 5xx as retryable in `FallbackModel`.

## Fix

- Remove Sonnet 3.7 from the fallback chain and treat 404 as terminal so the chain advances to the next provider.

---

## Metrics

**Performance:**
- Total latency: 535 seconds
- Token usage: 333,611 + 18,052 = 351,663 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, grep, codebase_search
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) read_file (input: the throwing function and its callers)
