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
- Total latency: 481 seconds
- Token usage: 406,410 + 18,453 = 424,863 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, query-otel, shell
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
