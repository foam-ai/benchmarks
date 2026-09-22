## TL;DR

The GitHub App token used by `GitWorktreeService` lacks access to the target repository, and GitHub reports missing permissions as a 404.

## What Broke and Why

**Observed error:** `Error: remote: Repository not found. fatal: repository 'https://github.com/foam-ai/mewtwo.git/' not found`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** GitHub returns 404 for both missing and unauthorised repositories.

**2.** Token scopes were recently rotated.

## Fix

- Grant the app installation access to the repository.

---

## Metrics

**Performance:**
- Total latency: 463 seconds
- Token usage: 286,244 + 21,748 = 307,992 tokens

**Tool Usage:**
- Top 3 most-used tools: search_issue_events, read_file, grep
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) read_file (input: the throwing function and its callers)
