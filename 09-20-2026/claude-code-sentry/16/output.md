## TL;DR

The Azure `apiVersion` (`2024-12-01-preview`) is too old for the Responses API and the deployment name has a typo, so the endpoint returns 404.

## What Broke and Why

**Observed error:** `APICallError: 404 Resource not found (/openai/deployments/.../responses)`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The URL includes a preview API version.

**2.** 404 is what Azure returns for unknown deployments.

## Fix

- Bump the API version and verify the deployment name.

---

## Metrics

**Performance:**
- Total latency: 482 seconds
- Token usage: 261,906 + 13,383 = 275,289 tokens

**Tool Usage:**
- Top 3 most-used tools: search_issue_events, Grep, Read
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
