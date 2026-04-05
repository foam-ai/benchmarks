## TL;DR

The `runSideEffects` function expects a property named `result` in its input object, but its caller `solveIssue` passes the solver's output under the key `solverResult`. This property-name mismatch causes `result` to always be `undefined` inside `runSideEffects`, making the empty-solution validation guard (`!result || result.trim().length === 0`) unconditionally throw — even when the agent produced a perfectly valid solution. Every issue-solver run has been failing at this step since the mismatch was introduced.

## What Broke and Why

### The Causal Chain

**Step 1 — A new validation was added (commit `8465a6f`, Jan 20 2026).**
To prevent empty AI-generated solutions from being uploaded to S3 and displayed in the UI, a guard was added at the top of `runSideEffects` in `/app/mewtwo/src/services/issue-solver/side-effects/index.ts`:

```typescript
// Validate that solution result is not empty
if (!result || result.trim().length === 0) {
    const error = new Error(
        `Solution result is empty for runId: ${runId}. Cannot mark as completed with empty solution.`,
    );
    throw error;
}
```

This validation is sound in isolation — but it only works if the parameter `result` is actually populated.

**Step 2 — A property key mismatch was introduced (commit `5b1505b`, Jan 21 2026).**
`solveIssue` in `/app/mewtwo/src/services/issue-solver/index.ts` calls `runSideEffects` like this:

```typescript
const solverResult = await runDefault(run);
// ...
await runSideEffects({
    run,
    customer,
    solverResult,          // ← shorthand for key "solverResult"
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

But `runSideEffects` destructures its argument expecting the key `result`, not `solverResult`:

```typescript
export const runSideEffects = wrapTraced(async function runSideEffects({
    run,
    customer,
    result,                // ← expects key "result"
    dbOnlyMode = false,
    notificationsEnabled = false,
}: {
    run: IssueSolverRunDocument;
    customer: Customer;
    result: string;
    // ...
})
```

Because `"solverResult" !== "result"`, JavaScript's object destructuring simply leaves `result` as `undefined` at runtime. The actual agent output — a valid, non-empty string returned by `runDefault` — is passed to the function but never read.

**Step 3 — TypeScript silently permits the mismatch.**
`runSideEffects` is wrapped with `wrapTraced`, whose signature is:

```typescript
export function wrapTraced<T>(
    fn: (...args: any[]) => Promise<T>,
    ...
): (...args: any[]) => Promise<T>
```

The `...args: any[]` erases the wrapped function's parameter shape. TypeScript sees the returned callable as accepting `any` arguments, so passing `{ solverResult: string }` instead of `{ result: string }` compiles without error.

**Step 4 — The guard fires unconditionally.**
At runtime, `result` is `undefined`. The check `!result` evaluates to `true`, and the error is always thrown — regardless of what `runDefault` actually returned. The log line `resultLength: result?.length || 0` always reports `0`, which superficially looks like an empty solution but is in fact a missing value.

**Step 5 — All runs fail; retries do not help.**
Telemetry shows the same run (`eb581e69-4677-42d6-b609-fa619edcd608`) was attempted three times (2026-01-21 and again 2026-01-30), each failing with the identical error. The first attempt ran for ~6.4 minutes with the `SimpletonAgent` performing 8+ ClickHouse queries and 4+ grep searches before successfully completing — only to be killed at the side-effects stage. This is not a solver quality issue; it is a deterministic code defect that rejects every run.

## Fix

**Rename the property key at the call site in `solveIssue`** so it matches what `runSideEffects` destructures:

```typescript
// Before (broken):
await runSideEffects({
    run,
    customer,
    solverResult,          // ← key "solverResult" is never read by runSideEffects
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});

// After (fixed):
await runSideEffects({
    run,
    customer,
    result: solverResult,  // ← maps the local variable to the expected key "result"
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

**Why this fix breaks the causal chain:** With `result: solverResult`, the destructuring in `runSideEffects` now receives the actual non-empty string produced by `runDefault`. The check `!result || result.trim().length === 0` evaluates to `false` for a valid solution, the guard does not throw, and execution proceeds normally. The bad state (`result === undefined`) can no longer be created, so the observed error cannot recur for runs where the agent produces a valid solution.

**Additional hardening (non-blocking):** To prevent this class of bug from silently compiling in the future, the `wrapTraced` utility should be given a stronger generic signature that preserves the wrapped function's parameter types, or `runSideEffects` should be called directly (without `wrapTraced`) so TypeScript enforces the call-site types. A strict integration test that calls the full `solveIssue → runSideEffects` path with a mock solver would also have caught this immediately.


---