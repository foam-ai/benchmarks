## TL;DR

When a user navigates to an issue detail page for an issue that hasn't been solved yet, the backend API returns `solution: ''` (empty string) as the "no solution" sentinel value. The frontend page component has an explicit guard that throws on exactly this condition (`issue.solution === ''`), causing the global Next.js error boundary to render a fallback UI. The fix is to change the backend to return `null` (or omit the field) instead of `''` when no solution exists, aligning with the frontend's `solution?: string` type contract.

## What Broke and Why

### Causal Chain

**Step 1 — Issue exists without a completed solver run.**
Issue `5b44b816-8c8d-4850-9860-007c73f2f038` is stored in the `foamissues` MongoDB collection, but no corresponding `IssueSolverRun` document with `status: COMPLETED` and a non-null `solutionS3URL` exists for it. This is a normal lifecycle state: issues are created when errors are detected, and solutions are only populated after the issue-solver pipeline completes (uploads the result to S3 and calls `setIssueSolverRunSuccessStatus`).

**Step 2 — Backend API defaults `solution` to empty string.**
In `/repo/mewtwo/src/routers/issues.ts`, the `GET /:issueId` endpoint looks up the S3 URL via:

```typescript
const solutionS3URL = await findLatestSolutionS3URLByFoamIssueId(issue._id);
const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : '';
```

The MongoDB query (`findLatestSolutionS3URLByFoamIssueId`) filters for `{ solutionS3URL: { $exists: true, $ne: null }, status: RunStatus.COMPLETED }` and returns `null` when no qualifying run exists. The ternary then sets `solutionText = ''`, and this is unconditionally serialized into the HTTP 200 response as `solution: ''`.

**Step 3 — Frontend type contract expects `null`/`undefined`, not `''`.**
The frontend issue type is defined as:

```typescript
// /repo/porygon/types/issues.ts
export interface Issue {
  solution?: string;  // optional — undefined means no solution yet
}
```

The backend, however, always sends the `solution` key with a value (either S3 content or `''`), creating a **type contract mismatch**: the backend treats `''` as "no solution" while the frontend type implies `undefined`/absent means "no solution."

**Step 4 — Frontend page guard throws on empty string.**
The page component explicitly distinguishes between three states:

```typescript
// /repo/porygon/app/(platform)/issues/[issueId]/page.tsx
if (issue.solution === '') {
  throw new Error(`Issue ${issueId} has an empty solution string`);
}
```

The comment reads: *"Throw exception if solution is empty string (not null or non-empty)"* — confirming this is an intentional guard. When `solution` is `null` or `undefined` the page presumably renders a "solving in progress" state; when it is a non-empty string it renders the solution. But when `solution === ''` — the state that the backend produces for every unsolved issue — the guard throws.

**Step 5 — Error caught by global error boundary, user sees fallback UI.**
Telemetry confirms: the error propagates up with `StatusCode: Error` and digest `660824337` on the RSC render span (`791a80d671a975dc`), but the browser-facing HTTP response is `200 OK`. Next.js serializes the error into the RSC payload (`2:E{"digest":"660824337"}`) and the `global-error.tsx` boundary renders a fallback UI. The user sees an error page instead of the issue detail — a degraded but non-crashing experience.

### Evidence Summary

- Telemetry span `7a794605771625b7`: backend `GET https://sdk.api.foam.ai/issues/5b44b816-8c8d-4850-9860-007c73f2f038` returned HTTP 200 — the API call succeeded, the data was bad.
- Telemetry MongoDB query on `issuesolverrun` with filter `{ solutionS3URL: { $exists: true, $ne: null }, status: <COMPLETED> }` — this query ran and found no matching document.
- Source code at `mewtwo/src/routers/issues.ts:83`: `solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : ''` — explicit empty-string fallback.
- Source code at `porygon/app/(platform)/issues/[issueId]/page.tsx`: `if (issue.solution === '') { throw new Error(...) }` — explicit throw on empty string.
- This error is **isolated to a single issue** — telemetry shows all other 20+ issue detail pages rendered successfully.

## Fix

**Change the backend to return `null` (or omit the field) instead of `''` when no solution exists.**

In `/repo/mewtwo/src/routers/issues.ts`:

```typescript
// Before (broken):
const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : '';
const formattedIssue: FormattedIssue = {
  ...
  solution: solutionText,
};

// After (fixed):
const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : null;
const formattedIssue: FormattedIssue = {
  ...
  solution: solutionText,  // null | string — aligns with frontend's solution?: string
};
```

Update the `FormattedIssue` type to reflect `solution: string | null` on the backend, and ensure the frontend `Issue` type handles `null` the same way it handles `undefined` (treat both as "no solution yet").

**Why this fix breaks the causal chain:** The frontend guard `if (issue.solution === '')` only fires on strict empty-string equality. By returning `null` instead of `''`, the backend eliminates the only path that produces `solution === ''` for unsolved issues — the guard condition can never be true for the "no solution yet" state, and the page will instead fall through to its normal "solving in progress" render path. The error would stop recurring entirely for issues in this state.

**Note on Scenario B (edge case):** If the issue-solver agent itself returns an empty string as its result, that `''` would be uploaded to S3, the run would be marked COMPLETED, and `getFromS3UrlAsText` would return `''` — still triggering the guard. A secondary safeguard should be added in `runSideEffects()` to validate that `result` is non-empty before uploading, preventing a truly empty solution from being persisted as COMPLETED.

---