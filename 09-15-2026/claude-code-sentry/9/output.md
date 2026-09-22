## TL;DR

An Anthropic API rate-limit incident caused 429s; the fallback to Bedrock failed because Bedrock quotas were also low at the time. The retry policy lacks backoff.

## What Broke and Why

**Observed error:** `RateLimitError: This request would exceed your organization's rate limit of 4,000,000 tokens per minute`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** Both providers returned rate-limit errors within the same minute.

**2.** No backoff between the primary and fallback attempts.

## Fix

- Add exponential backoff and request a higher Bedrock quota.

---

## Metrics

**Performance:**
- Total latency: 345 seconds
- Token usage: 468,945 + 23,807 = 492,752 tokens

**Tool Usage:**
- Top 3 most-used tools: Grep, Read, get_sentry_resource
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
