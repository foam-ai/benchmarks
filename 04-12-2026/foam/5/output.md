[Foam Trace ID: 77a7778d560b4ede488ec2d24dab1ea6] ## TL;DR

`runDefault` successfully produced a 2,929-character solution report, but it was silently discarded because the caller passed it to `runSideEffects` under the key `solverResult` while the function destructures for the key `result`. JavaScript's object destructuring assigned `undefined` to `result`, causing the empty-solution guard to throw — even though the solver completed successfully.

## What Broke and Why

### Root Cause: Property Name Mismatch in Object Destructuring

In `src/services/issue-solver/index.ts`, after `runDefault` completes, its return value is stored in a local variable named `solverResult` and passed into `runSideEffects` using ES6 shorthand property syntax:

```ts
// index.ts (line ~36–47)
const solverResult = await runDefault(run);  // returns a 2929-char string ✓

await runSideEffects({
    run,
    customer,
    solverResult,         // ← shorthand for { solverResult: solverResult }
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

However, `runSideEffects` in `src/services/issue-solver/side-effects/index.ts` destructures its argument expecting the key `result`, not `solverResult`:

```ts
// side-effects/index.ts (line ~12–31)
async function runSideEffects({
    run,
    customer,
    result,               // ← expects key "result" — not present in caller's object
    dbOnlyMode = false,
    notificationsEnabled = false,
}: {
    run: IssueSolverRunDocument;
    customer: Customer;
    result: string;
    ...
})
```

Because JavaScript object destructuring silently resolves missing keys as `undefined`, `result` is `undefined` inside `runSideEffects` — regardless of what `runDefault` actually returned. The existing guard on line ~30:

```ts
if (!result || result.trim().length === 0) {
    throw new Error(
        `Solution result is empty for runId: ${runId}. Cannot mark as completed with empty solution.`
    );
}
```

evaluates `!undefined` as `true` and throws immediately, with `resultLength: 0` (from `result?.length || 0`).

### Telemetry Evidence Confirming the Chain

The span logs for trace `4476aee1d2c728dad742dc83d95c3db9` confirm:
- `23:34:15.419` — `[SimpletonAgent] completeTask` logged with `reportLength: 2929` — the solver **did** produce a full report
- `23:34:15.437` — `[SimpletonAgent] Run completed` — `success: true`, `durationMs: 362659`, `episodeCount: 62`
- `23:34:36.383` — `[default] Run solve completed` — `success: true`
- `23:34:36.393` — `[SideEffects] Empty solution detected` — `resultLength: 0` — thrown 20ms after the successful solve

The `resultLength: 0` is the tell-tale sign: a truly empty result from `runDefault` would be `undefined` (since `runDefault` throws rather than returning an empty string), and `undefined?.length || 0` evaluates to `0` — matching the log exactly.

### Why TypeScript Didn't Catch This

The `runSideEffects` function type signature declares `result: string`, and the caller's object does include a field named `solverResult: string`. Because the call site uses shorthand `{ solverResult }` rather than `{ result: solverResult }`, TypeScript would flag this as a type error if both `result` and `solverResult` are checked — however, if the TypeScript configuration or type definitions at the call site were loose, or if this was introduced as a refactor that renamed the variable without updating the call site, this mismatch can slip through.

## Fix

**At the call site in `src/services/issue-solver/index.ts`**, rename the property key passed to `runSideEffects` to match what the function expects:

```ts
// Before (broken):
await runSideEffects({
    run,
    customer,
    solverResult,   // ← wrong key name
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});

// After (fixed):
await runSideEffects({
    run,
    customer,
    result: solverResult,   // ← correct: maps the local variable to the expected key
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

**Why this fix breaks the causal chain:** The destructuring in `runSideEffects` will now find the key `result` in the passed object and bind it to the actual 2,929-character string returned by `runDefault`. The guard `if (!result || result.trim().length === 0)` will evaluate to `false`, and the solver output will be processed normally. The "empty solution" error will no longer be thrown for successful runs.

**Prevention:** To prevent this class of bug from recurring, enable strict TypeScript checking at the call site (or add an explicit type annotation to the argument object). If the call site had been typed as `Parameters<typeof runSideEffects>[0]`, TypeScript would have caught the missing `result` key at compile time.


---
