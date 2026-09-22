## TL;DR

The new empty-solution validation is firing correctly, but on a caller bug: `runSideEffects` is called with `solverResult` while the function destructures `result`, so the value is always `undefined`.

## What Broke and Why

**Observed error:** `Error: Solution result is empty (side-effects/index.ts)`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** The solver produces a full solution (visible in traces) right before the throw.

**2.** Shorthand property `solverResult` at the call site vs. `result` in the destructuring pattern — TypeScript did not catch it because the parameter type is loose.

## Fix

- Rename the parameter to `solverResult` and tighten the argument type so extra/missing keys are compile errors.

---

## Metrics

**Performance:**
- Total latency: 476 seconds
- Token usage: 566,140 + 19,892 = 586,032 tokens

**Tool Usage:**
- Top 3 most-used tools: Grep, query-otel, Bash
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) Read (input: the throwing function and its callers) Grep (input: the error string across the repo)
