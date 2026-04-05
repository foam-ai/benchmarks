## TL;DR
Commit `88751b2a` added a `throw` on empty solution strings in the issue detail page, but the backend API already returns `solution: ''` for any issue without a completed solver run — a perfectly normal state — causing an unhandled crash when users view unsolved issues.

## What Broke and Why

**The causality chain:**

1. **Commit `d06cda05` (Jan 9, 2026) — "add solution text to issues"** added the `solution` field to the issues API. In the backend router (`mewtwo/src/routers/issues.ts`, line 83), when fetching an individual issue, the code is:
   ```typescript
   const solutionS3URL = await findLatestSolutionS3URLByFoamIssueId(issue._id);
   const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : '';
   ```
   When no completed solver run with an S3 URL exists for an issue (i.e., the issue hasn't been solved yet), `findLatestSolutionS3URLByFoamIssueId` returns `null`, and `solutionText` is set to `''` (empty string). This is a legitimate, common state — many issues exist in the system before the solver processes them.

2. **Commit `88751b2a` (Jan 20, 2026) — "One simple baby eval and another decent eval"** introduced a validation check in `porygon/app/(platform)/issues/[issueId]/page.tsx` (lines 55–58):
   ```typescript
   // Throw exception if solution is empty string (not null or non-empty)
   if (issue.solution === '') {
     throw new Error(`Issue ${issueId} has an empty solution string`);
   }
   ```
   This check treats an empty solution string as a data integrity error and throws an unrecoverable exception. However, the backend *deliberately* returns `''` for unsolved issues. The comment even acknowledges the distinction between empty string, null, and non-empty — but the code incorrectly classifies empty string as an error rather than a valid "no solution yet" state.

3. **Error (Jan 21, 2026 03:22 UTC):** A user navigated to issue `5b44b816-8c8d-4850-9860-007c73f2f038`. The backend found no completed solver run with a solution S3 URL for this issue, returned `solution: ''`. The new frontend check threw an unhandled `Error`, which propagated through Next.js SSR rendering and was logged to telemetry.

**Why the downstream code was already fine:** The `IssuePage` component (`porygon/components/issues/IssuePage.tsx`, line 37) already gracefully handles missing/empty solutions:
```typescript
{'solution' in issue && issue.solution && (
  // only renders solution card if solution is truthy
)}
```
The empty string `''` is falsy, so no solution card would render — which is the correct behavior. The throw in `page.tsx` preempts this graceful handling and crashes the entire page instead.

**The frontend type definition also confirms this is expected:** `porygon/types/issues.ts` defines `solution?: string` (optional), acknowledging that issues may not have solutions.

## Fix

**Primary fix — Remove the incorrect throw in the frontend page** (`porygon/app/(platform)/issues/[issueId]/page.tsx`):

Remove lines 55–58:
```diff
-  // Throw exception if solution is empty string (not null or non-empty)
-  if (issue.solution === '') {
-    throw new Error(`Issue ${issueId} has an empty solution string`);
-  }
```

The `IssuePage` component already handles empty/missing solutions gracefully by conditionally rendering the solution card only when `issue.solution` is truthy.

**Secondary fix — Return `null` instead of `''` from the backend** (`mewtwo/src/routers/issues.ts`, line 83):

```diff
-  const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : '';
+  const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : null;
```

And update the `FormattedIssue` interface (line 48):
```diff
-  solution: string;
+  solution: string | null;
```

This makes the API semantically clearer: `null` means "no solution exists" rather than conflating it with an empty string, which could also theoretically mean "the solver returned empty output."

---

## Metrics

**Performance:**
- Total latency: ~120 seconds
- Token usage: ~15000 input tokens + ~4000 output tokens = ~19000 total tokens
- **Model used: opus-4.6** ← REQUIRED - DO NOT CHANGE

**Tool Usage:**
- Top 3 most-used tools: Shell (query-otel, git), Grep, Read
- Top 3 most USEFUL tools: Grep (input: "empty solution string" in porygon/ — found the exact error source), Read (input: porygon/app/(platform)/issues/[issueId]/page.tsx and mewtwo/src/routers/issues.ts — revealed the full causality chain), Shell/query-otel (input: SELECT * FROM otel_logs WHERE TraceId = '3df47fd48e3bc18595edc2bc21b25ee0' — confirmed the error and service context)
