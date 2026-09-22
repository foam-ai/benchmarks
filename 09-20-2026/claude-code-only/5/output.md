## TL;DR

The new empty-solution validation is firing correctly, but on a caller bug: `runSideEffects` is called with `solverResult` while the function destructures `result`, so the value is always `undefined`.

## What Broke and Why

**Observed error:** `Error: Solution result is empty (side-effects/index.ts)`

### Causal Chain

**1.** The solver produces a full solution (visible in traces) right before the throw.

**2.** Shorthand property `solverResult` at the call site vs. `result` in the destructuring pattern — TypeScript did not catch it because the parameter type is loose.

## Fix

- Rename the parameter to `solverResult` and tighten the argument type so extra/missing keys are compile errors.

---

## Metrics

**Performance:**
- Total latency: 542 seconds
- Token usage: 465,063 + 12,044 = 477,107 tokens

**Tool Usage:**
- Top 3 most-used tools: Read, Agent, Grep
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
