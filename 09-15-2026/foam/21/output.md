[Foam Trace ID: 3407a73ddc885f7037e2a61fdeed3085] ## TL;DR

The eval case `foam-mini-solver-terminal-velocity-failed-after-unavailable-memory` references a `runId` that has no `IssueSolverRun` document in MongoDB, so `findIssueSolverRunByRunId()` returns `null` and throws. The fixture is stale, not the code.

## What Broke and Why

**Observed error:** `Error: Issue solver run not found for runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** Direct lookup of the runId in the production database returns nothing.

**2.** The run was likely deleted or the ID was copied incorrectly into `rca-evals.ts`.

## Fix

- Replace the runId in the eval case with a valid one and add a fixture check to CI.


---
