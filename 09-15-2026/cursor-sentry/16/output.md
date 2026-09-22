## TL;DR

The Azure resource does not expose the Responses API at the URL the AI SDK builds with deployment-based URLs; the API version may also be a factor.

## What Broke and Why

**Observed error:** `APICallError: 404 Resource not found (/openai/deployments/.../responses)`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** Deployment-based `/responses` path 404s while chat completions work.

**2.** Preview API version in use.

## Fix

- Switch to v1-style URLs for the responses model and bump the API version.

---

## Metrics

**Performance:**
- Total latency: 509 seconds
- Token usage: 253,555 + 21,882 = 275,437 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, get_sentry_resource, search_issue_events
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) read_file (input: the throwing function and its callers)
