## TL;DR

An unauthenticated user hit `/issues`; `getUser()` returned `null` for the missing session cookie, and the page dereferenced `user!.customerId` with a non-null assertion and no guard.

## What Broke and Why

**Observed error:** `TypeError: Cannot read properties of null (reading 'customerId')`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The non-null assertion hides the nullable return type from the compiler.

**2.** Next.js suppresses the message in production, which is why the Sentry event is terse.

## Fix

- Redirect to login (or `notFound()`) when `getUser()` returns `null` and remove the `!`.

---

## Metrics

**Performance:**
- Total latency: 259 seconds
- Token usage: 418,967 + 6,197 = 425,164 tokens

**Tool Usage:**
- Top 3 most-used tools: shell, read_file, search_issue_events
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
