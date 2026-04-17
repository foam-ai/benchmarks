[Foam Trace ID: 91e9b172fbff8a5873954633b1485c72] ## TL;DR

Every time the issue solver pipeline runs, it uploads `undefined` to S3 instead of the generated solution text — because `solveIssue` passes the result under the key `solverResult` but `runSideEffects` destructures it as `result`, silently receiving `undefined`. The `wrapTraced` wrapper erases TypeScript parameter types to `(...args: any[])`, so the compiler never catches the mismatch. The fix is a one-word rename: `solverResult` → `result` at the `runSideEffects` call site.

---

## What Broke and Why

### Deepest Root Cause: Parameter Key Name Mismatch in `solveIssue`

In `mewtwo/src/services/issue-solver/index.ts` (confirmed at commit `88751b2a0bd62c5e8c9b865ef08f9cc1206e7445`), the solver pipeline stores its output as `solverResult` and then passes it to `runSideEffects` using that same key name:

```ts
// index.ts ~line 36
const solverResult = await runDefault(run);

// index.ts ~lines 58–64  ← BUG HERE
await runSideEffects({
    run: updatedRun,
    customer,
    solverResult,          // ← key is `solverResult`
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

However, `runSideEffects` in `side-effects/index.ts` destructures the parameter as `result`, not `solverResult`:

```ts
export const runSideEffects = wrapTraced(async function runSideEffects({
    run,
    customer,
    result,                // ← expects key `result`
    dbOnlyMode = false,
    notificationsEnabled = false,
}: {
    result: string;        // TypeScript annotation — never checked at runtime
    ...
}): Promise<void> {
    ...
    solutionS3URL = await uploadSolutionToS3(customer._id, runId, issueIdentifier, result);
    //                                                                               ^^^^^^ undefined at runtime
```

At runtime, `result` resolves to `undefined` because the caller passed `solverResult` instead. JavaScript silently discards unknown object keys during destructuring.

### Why TypeScript Didn't Catch It

The `wrapTraced` helper in `braintrust-wrapper.ts` is typed as:

```ts
export function wrapTraced<T>(
    fn: (...args: any[]) => Promise<T>,   // ← erases all param types
): (...args: any[]) => Promise<T> {       // ← return type also `any[]`
```

Both the input function signature and the returned callable are `(...args: any[])`. This means the specific object-destructuring constraint `{ result: string }` is widened to `any` the moment `runSideEffects` is wrapped. The call site in `index.ts` sees `runSideEffects` as accepting `any` arguments — so passing `{ solverResult }` instead of `{ result }` is completely invisible to the compiler. The `eslint-disable` comments confirm this type erasure was a known trade-off.

### The Full Causal Chain (Write Path → Read Path → Crash)

1. **Solver runs successfully** — `runDefault(run)` returns a valid markdown solution string stored in `solverResult`.
2. **`runSideEffects` is called with wrong key** — `result` is `undefined` inside the function.
3. **`uploadSolutionToS3(..., undefined)` is called** — S3 accepts the upload and returns a valid `s3://...` URL, but the stored object has empty/undefined content.
4. **`updateIssueSolverRunWithSolutionS3URL(run, solutionS3URL)` persists the URL** — a valid-looking S3 URL is written to MongoDB with no content guard.
5. **`setIssueSolverRunSuccessStatus(runId)` marks the run `COMPLETED`** — the broken run looks healthy in the DB.
6. **Frontend requests the issue page** — telemetry shows `porygon-server` makes `fetch GET https://sdk.api.foam.ai/issues/5b44b816...`, which returns HTTP 200 after 929ms.
7. **`mewtwo` API serves the issue** — `findLatestSolutionS3URLByFoamIssueId` finds the COMPLETED run with a non-null `solutionS3URL`, so it fetches from S3:
   ```ts
   const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : '';
   // solutionS3URL is non-null → fetches from S3 → empty content → solutionText = ''
   ```
8. **`solution: ''` is returned** in the `FormattedIssue` response body.
9. **Page component guard fires** in `porygon/app/(platform)/issues/[issueId]/page.tsx`:
   ```ts
   if (issue.solution === '') {
       throw new Error(`Issue ${issueId} has an empty solution string`);
   }
   ```
10. **RSC render crashes** — Next.js encodes the error as RSC chunk `2:E{"digest":"660824337"}` and the browser receives an HTTP 200 response that triggers a React error boundary. The error is persistent: it recurs on every subsequent page load (confirmed by a second identical crash at `03:23:13` in trace `2cc39ece...`) because the COMPLETED run with the empty S3 object is already persisted in MongoDB.

### Why the "Race Condition" Hypothesis Was Ruled Out

Agent 3 raised an alternative: the page was loaded before any completed solver run existed (no `solutionS3URL` → `findLatestSolutionS3URLByFoamIssueId` returns `null` → `solutionText = ''`). This is ruled out by the persistence of the error — the exact same crash recurs on multiple page load attempts minutes apart. If it were a pre-completion race, the second load (after the solver finished) would succeed. The persistent empty solution is consistent only with a COMPLETED run whose S3 object contains empty content (Scenario B), caused by the write-path bug.

---

## Fix

### Primary Fix — Rename the key at the call site

In `mewtwo/src/services/issue-solver/index.ts`, rename `solverResult` to `result` when calling `runSideEffects`:

```ts
// BEFORE (buggy)
await runSideEffects({
    run: updatedRun,
    customer,
    solverResult,           // ← wrong key
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});

// AFTER (fixed)
await runSideEffects({
    run: updatedRun,
    customer,
    result: solverResult,   // ← correct key, preserves local variable name
    dbOnlyMode: options.dbOnlyMode,
    notificationsEnabled: options.notificationsEnabled,
});
```

**Why this breaks the causal chain:** With the correct key, `result` inside `runSideEffects` will be the actual solution string (non-empty) rather than `undefined`. `uploadSolutionToS3` will upload real content, `getFromS3UrlAsText` will return the solution text, and `issue.solution` will be non-empty — the page guard will never fire.

### Secondary Fix — Restore type safety through `wrapTraced`

The underlying enabler of this silent bug is that `wrapTraced` erases the function's TypeScript parameter types. Fix `wrapTraced` to preserve the wrapped function's signature:

```ts
// braintrust-wrapper.ts
export function wrapTraced<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn>,
    options?: Parameters<typeof braintrust.wrapTraced>[1],
): (...args: TArgs) => Promise<TReturn> {
```

This restores TypeScript's ability to catch call-site key mismatches on any `wrapTraced`-wrapped function going forward.

### Tertiary Fix — Write-path guard in `runSideEffects`

Add a runtime assertion before the S3 upload to catch empty/undefined results defensively:

```ts
if (!result) {
    throw new Error(`runSideEffects called with empty result for runId ${runId}`);
}
```

This ensures that even if a similar mismatch slips through in the future, the pipeline fails loudly at the write path rather than silently persisting an empty S3 object.


---
