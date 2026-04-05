## TL;DR
Property name mismatch (`solverResult` vs `result`) when calling `runSideEffects` caused the solution string to be passed as `undefined`, triggering the "empty solution" error.

## What Broke and Why
In `mewtwo/src/services/issue-solver/index.ts` (line 41-47), the `runSideEffects` function is called with the object property `solverResult` using JavaScript shorthand property notation:

```typescript
const solverResult = await runDefault(run);
// ...
await runSideEffects({
    run,
    customer,
    solverResult,   // creates property named 'solverResult'
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

However, `runSideEffects` in `mewtwo/src/services/issue-solver/side-effects/index.ts` destructures a property named `result`:

```typescript
export const runSideEffects = wrapTraced(async function runSideEffects({
    run, customer, result, dbOnlyMode, notificationsEnabled
}: { ...; result: string; ... })
```

The shorthand `solverResult` creates a property called `solverResult` on the passed object, but the function looks for `result` — which is `undefined`. The validation guard at line 30 (`if (!result || result.trim().length === 0)`) correctly catches this undefined value and throws the error: `"Solution result is empty for runId: eb581e69-4677-42d6-b609-fa619edcd608. Cannot mark as completed with empty solution."`

**Why TypeScript didn't catch it:** The `wrapTraced` utility function uses `(...args: any[]) => Promise<T>` as its signature (line 56 of `braintrust-wrapper.ts`), which erases all parameter type information from the wrapped function. This means TypeScript cannot type-check the arguments passed to any `wrapTraced`-wrapped function, allowing this property name mismatch to slip through to runtime.

**Telemetry evidence:** The logs confirm the SimpletonAgent ran successfully to completion (it performed multiple queryOtel and grep tool calls), but the valid report string was discarded due to the property name mismatch when passing it to side effects.

## Fix
In `mewtwo/src/services/issue-solver/index.ts`, change the shorthand property to an explicit property mapping:

```diff
 await runSideEffects({
     run,
     customer,
-    solverResult,
+    result: solverResult,
     dbOnlyMode: options.dbOnlyMode,
     notificationsEnabled: options.notificationsEnabled,
 });
```

**Secondary fix (recommended):** Improve the `wrapTraced` type signature to preserve parameter types, preventing similar silent mismatches in the future:

```typescript
export function wrapTraced<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn>,
    options?: Parameters<typeof braintrust.wrapTraced>[1],
): (...args: TArgs) => Promise<TReturn> {
```

---
