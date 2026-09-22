## TL;DR

The new empty-solution validation is firing correctly, but on a caller bug: `runSideEffects` is called with `solverResult` while the function destructures `result`, so the value is always `undefined`.

## What Broke and Why

**Observed error:** `Error: Solution result is empty (side-effects/index.ts)`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The solver produces a full solution (visible in traces) right before the throw.

**2.** Shorthand property `solverResult` at the call site vs. `result` in the destructuring pattern — TypeScript did not catch it because the parameter type is loose.

## Fix

- Rename the parameter to `solverResult` and tighten the argument type so extra/missing keys are compile errors.

---

## Metrics

**Performance:**
- Total latency: 216 seconds
- Token usage: 299,576 + 11,372 = 310,948 tokens

**Tool Usage:**
- Top 3 most-used tools: Grep, Read, Glob
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
