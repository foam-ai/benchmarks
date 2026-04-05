## TL;DR
Property name mismatch: caller passes `solverResult` but `runSideEffects` destructures `result`, so the solution string is always `undefined`.

## What Broke and Why
In `mewtwo/src/services/issue-solver/index.ts` (line 36), the return value of `runDefault(run)` is stored in a variable called `solverResult`. On line 44, it is passed to `runSideEffects` using JavaScript shorthand property syntax: `{ ..., solverResult, ... }`. This creates an object with a key named `solverResult`.

However, `runSideEffects` in `mewtwo/src/services/issue-solver/side-effects/index.ts` destructures its argument expecting a property named `result` — not `solverResult`. Because the object has no `result` key, the destructured `result` parameter is `undefined`.

The validation guard on line 30 (`if (!result || result.trim().length === 0)`) then correctly detects that `result` is falsy and throws: `"Solution result is empty for runId: ..."`. This error fires on every single issue-solver invocation, producing 658 occurrences across all customers.

The likely cause is a rename: either `solverResult` was previously named `result` in the caller (and was renamed without updating the call site to use explicit key mapping), or `runSideEffects` previously accepted `solverResult` and was refactored to expect `result` without updating callers.

TypeScript would normally catch this at compile time, but `wrapTraced` (a Braintrust tracing wrapper) likely uses generic or loosely-typed function wrapping that erases the strict parameter type, allowing the mismatch to pass type-checking silently.

## Fix
In `mewtwo/src/services/issue-solver/index.ts`, change the call to `runSideEffects` to explicitly map the property name:

```typescript
await runSideEffects({
    run,
    customer,
    result: solverResult,       // was: solverResult (shorthand — wrong key name)
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

This ensures the object passed to `runSideEffects` has a `result` key matching what the function destructures.

---
