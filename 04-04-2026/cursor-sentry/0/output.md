## TL;DR
Property name mismatch: `solveIssue` passes `solverResult` (shorthand) to `runSideEffects`, but the function destructures it as `result`, making `result` always `undefined`.

## What Broke and Why

The failure chain is:

1. **The caller uses ES6 shorthand with the wrong property name.** In `mewtwo/src/services/issue-solver/index.ts` (line 55-61), `solveIssue` calls `runSideEffects` passing `solverResult` as an ES6 shorthand property:

   ```typescript
   await runSideEffects({
       run: updatedRun,
       customer,
       solverResult,          // Creates { solverResult: "..." }
       dbOnlyMode: options.dbOnlyMode,
       notificationsEnabled: options.notificationsEnabled,
   });
   ```

2. **The callee expects a different property name.** In `mewtwo/src/services/issue-solver/side-effects/index.ts` (line 12-24), `runSideEffects` destructures `result` from its parameter object:

   ```typescript
   export const runSideEffects = wrapTraced(async function runSideEffects({
       run,
       customer,
       result,                // Expects { result: "..." } — receives undefined!
       dbOnlyMode = false,
       notificationsEnabled = false,
   })
   ```

   Since the passed object contains `solverResult` but not `result`, the destructured `result` is `undefined`.

3. **TypeScript did not catch this mismatch** because the `wrapTraced` wrapper in `mewtwo/src/services/braintrust-wrapper.ts` erases parameter types. Its return type is `(...args: any[]) => Promise<T>`, which means the returned function accepts any arguments — the compiler cannot verify the shape of the parameter object.

4. **At runtime, `result` is `undefined`**, so when the code reaches the S3 upload path (`uploadSolutionToS3`), it uploads `undefined` as the solution content. The deployed version also added an explicit empty-result validation check that throws the error observed in Sentry: `"Solution result is empty for runId: ..."`.

5. **This affects every single run**, producing 658 occurrences of the error. The agent (`SimpletonAgent` / `DeepResearchAgent`) successfully produces a report, but the result is silently discarded due to the property name mismatch.

## Fix

**Immediate fix** — Change line 58 in `mewtwo/src/services/issue-solver/index.ts` from shorthand to explicit property mapping:

```typescript
await runSideEffects({
    run: updatedRun,
    customer,
    result: solverResult,      // was: solverResult (shorthand, wrong name)
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

**Preventive fix** — Improve the `wrapTraced` return type in `mewtwo/src/services/braintrust-wrapper.ts` to preserve parameter types instead of erasing them with `any[]`:

```typescript
export function wrapTraced<Args extends unknown[], T>(
    fn: (...args: Args) => Promise<T>,
    options?: Parameters<typeof braintrust.wrapTraced>[1],
): (...args: Args) => Promise<T> {
```

This would allow TypeScript to catch property-name mismatches at compile time, preventing this entire class of bug.

---
