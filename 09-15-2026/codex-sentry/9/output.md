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
- Total latency: 492 seconds
- Token usage: 431,685 + 11,514 = 443,199 tokens

**Tool Usage:**
- Top 3 most-used tools: update_plan, shell, search_issue_events
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
