## TL;DR

The `runSideEffects` call in `mewtwo` passes `solverResult` but the function destructures `result`, so `result` is always `undefined`; an empty string is uploaded to S3, the run is marked `completed`, and `porygon` throws when it fetches `{ solution: '' }`.

## What Broke and Why

**Observed error:** `Error: Solution is empty (porygon/app/issues/[id]/page.tsx)`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** `mewtwo/src/services/issue-solver/index.ts` calls `runSideEffects({ run, customer, solverResult, ... })` using shorthand property syntax.

**2.** `side-effects/index.ts` destructures `{ run, customer, result }` — there is no `result` key in the argument, so it is `undefined` and coerced to `''` on upload.

**3.** The S3 upload has no empty-string guard and the run status is set to `completed`, so the failure is only visible when the frontend renders the issue and hits the hard throw on an empty solution.

## Fix

- Rename the destructured parameter to `solverResult` (or pass `result: solverResult`) so the types line up and TypeScript catches this class of bug.
- Add a non-empty assertion before the S3 upload and before marking the run `completed`.

---

## Metrics

**Performance:**
- Total latency: 454 seconds
- Token usage: 311,417 + 17,077 = 328,494 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, get_sentry_resource, grep
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) read_file (input: the throwing function and its callers)
