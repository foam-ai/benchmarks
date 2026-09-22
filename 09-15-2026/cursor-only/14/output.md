## TL;DR

An unauthenticated user hit `/issues`; `getUser()` returned `null` for the missing session cookie, and the page dereferenced `user!.customerId` with a non-null assertion and no guard.

## What Broke and Why

**Observed error:** `TypeError: Cannot read properties of null (reading 'customerId')`

### Causal Chain

**1.** The non-null assertion hides the nullable return type from the compiler.

**2.** Next.js suppresses the message in production, which is why the Sentry event is terse.

## Fix

- Redirect to login (or `notFound()`) when `getUser()` returns `null` and remove the `!`.

---

## Metrics

**Performance:**
- Total latency: 406 seconds
- Token usage: 465,939 + 14,633 = 480,572 tokens

**Tool Usage:**
- Top 3 most-used tools: list_dir, codebase_search, read_file
- Top 3 most USEFUL tools: read_file (input: the throwing function and its callers) grep (input: the error string across the repo) codebase_search (input: where the failing code path is invoked)
