## TL;DR
Property name mismatch: caller passes `solverResult` but `runSideEffects` expects `result`, so the solution string arrives as `undefined`, triggering the empty-solution validation error. The mismatch is invisible to TypeScript because `wrapTraced` erases parameter types with `any[]`.

## What Broke and Why
The failure chain is:

1. **`solveIssue`** (`mewtwo/src/services/issue-solver/index.ts`) calls `runDefault(run)` which successfully returns the agent's report as a `string`, stored in a local variable named `solverResult`.

2. **`solveIssue`** then calls `runSideEffects` using **shorthand property syntax**:
   ```typescript
   await runSideEffects({
       run,
       customer,
       solverResult,        // shorthand → creates property "solverResult"
       dbOnlyMode: ...,
       notificationsEnabled: ...,
   });
   ```
   This creates an object with a property named `solverResult`, not `result`.

3. **`runSideEffects`** (`mewtwo/src/services/issue-solver/side-effects/index.ts`) destructures its argument expecting a property named `result`:
   ```typescript
   async function runSideEffects({ run, customer, result, ... })
   ```
   Since the passed object has no `result` property (it has `solverResult` instead), `result` is `undefined`.

4. The validation guard at line 30 catches this:
   ```typescript
   if (!result || result.trim().length === 0) {
       throw new Error(`Solution result is empty for runId: ${runId}...`);
   }
   ```
   `!undefined` is `true`, so the error is thrown — even though the solver actually produced a valid report.

5. **Why TypeScript didn't catch this**: The `wrapTraced` wrapper function has the signature `fn: (...args: any[]) => Promise<T>`, which erases all parameter type information. The returned function is typed as `(...args: any[]) => Promise<T>`, so the caller can pass any argument shape without a type error. This means the mismatch between `solverResult` and `result` is completely invisible at compile time.

## Fix
In `mewtwo/src/services/issue-solver/index.ts`, change the call to `runSideEffects` to use the correct property name `result` instead of the shorthand `solverResult`:

```typescript
// Before (broken):
await runSideEffects({
    run,
    customer,
    solverResult,
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});

// After (fixed):
await runSideEffects({
    run,
    customer,
    result: solverResult,
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

This maps the local `solverResult` variable to the `result` property that `runSideEffects` expects, so the solution string is correctly passed through for S3 upload and database persistence.

**Recommended follow-up**: Improve `wrapTraced`'s type signature to preserve parameter types (e.g., using generics over the function signature rather than `any[]`), so TypeScript can catch this class of bug at compile time.
