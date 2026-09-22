[Foam Trace ID: bfae4f47f11bb1c32022a5be92935c58] ## TL;DR

The `runSideEffects` call in `mewtwo` passes `solverResult` but the function destructures `result`, so `result` is always `undefined`; an empty string is uploaded to S3, the run is marked `completed`, and `porygon` throws when it fetches `{ solution: '' }`.

## What Broke and Why

**Observed error:** `Error: Solution is empty (porygon/app/issues/[id]/page.tsx)`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** `mewtwo/src/services/issue-solver/index.ts` calls `runSideEffects({ run, customer, solverResult, ... })` using shorthand property syntax.

**2.** `side-effects/index.ts` destructures `{ run, customer, result }` — there is no `result` key in the argument, so it is `undefined` and coerced to `''` on upload.

**3.** The S3 upload has no empty-string guard and the run status is set to `completed`, so the failure is only visible when the frontend renders the issue and hits the hard throw on an empty solution.

## Fix

- Rename the destructured parameter to `solverResult` (or pass `result: solverResult`) so the types line up and TypeScript catches this class of bug.
- Add a non-empty assertion before the S3 upload and before marking the run `completed`.


---
