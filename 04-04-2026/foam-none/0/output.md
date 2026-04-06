[Foam Trace ID: bef14d2912cec31a39382f2a1067a877] ## TL;DR

The issue detail page at `/issues/[issueId]` crashes when an issue's `solution` field is an empty string `''`. The root cause is that the write path (issue creation/update) persists empty strings without normalizing them to `null`, and the page component throws an unhandled error on `solution === ''` instead of treating it as a valid "no solution yet" state.

## What Broke and Why

When a user navigates to the issue detail page for issue `5b44b816-8c8d-4850-9860-007c73f2f038`, the `IssuePage` React Server Component in `/repo/porygon/app/(platform)/issues/[issueId]/page.tsx` fetches the issue data via a cached `getData` function that calls `getIssue(issueId, cookieString)` from `@/actions/issues`. The issue is fetched successfully (not 401, not 404), and the issue object is truthy — but its `solution` field is an empty string `''`.

The page component has sequential guard checks, and the fourth guard explicitly throws on this condition:

```typescript
if (issue.solution === '') {
  throw new Error(`Issue ${issueId} has an empty solution string`);
}
```

This throw occurs during RSC streaming after HTTP headers have already been sent (the telemetry shows `HTTP Status Code: 200` despite the error), resulting in a broken page rendered via Next.js error digest `660824337`.

The **deeper root cause** is in the write path: the `solution` field on the Issue model is persisted as an empty string `''` rather than `null` when no solution has been provided. This most likely occurs because:

1. **The database column defaults to `''`** — When an issue is created without explicitly setting a solution, the column default populates `''` instead of `NULL`. This is a common pattern in ORMs like Prisma (e.g., `solution String @default("")`).
2. **No empty-string-to-null normalization exists on the write path** — When a form submission or API call sends `solution: ""` (e.g., a user clearing a solution textarea), the value is persisted as-is without normalization like `solution = value || null`.

The `getIssue()` server action faithfully returns whatever value is stored in the database, including the empty string. The page component's guard treats `''` as an error condition by throwing, but this is a band-aid — `null`/`undefined` pass through the same guard and are handled gracefully downstream (the `IssueDetailsPage` component already handles the "no solution" case for null values). The empty string `''` is simply a representational variant of "no solution" that was not accounted for consistently across the read and write paths.

The telemetry confirms this is a pure read-path failure on a single RSC streaming request (`RSC GET /issues/[issueId]`, trace `3df47fd48e3bc18595edc2bc21b25ee0`, span `791a80d671a975dc`, duration 1004ms) with no concurrent write operations, sibling spans, or evidence of data corruption from external sources.

## Fix

**Primary fix — Write-path normalization:** In the server action(s) that create or update issues (in `@/actions/issues` or equivalent), normalize empty strings to `null` before persisting:

```typescript
const normalizedSolution = solution === '' ? null : solution;
```

This should be applied in every mutation that writes the `solution` field (create, update, and any bulk/migration operations). Additionally, if the database schema defaults `solution` to `''`, change the default to `NULL` (and make the column nullable if it isn't already):

```prisma
// Before (likely current state):
solution String @default("")

// After:
solution String?
```

**Secondary fix — Graceful read-path handling:** Replace the `throw` in `IssuePage` with graceful handling that treats `''` the same as `null`:

```typescript
// Before:
if (issue.solution === '') {
  throw new Error(`Issue ${issueId} has an empty solution string`);
}

// After:
const normalizedIssue = {
  ...issue,
  solution: issue.solution === '' ? null : issue.solution,
};
// Pass normalizedIssue to IssueDetailsPage
```

This two-layer fix breaks the causal chain at both the source (no more empty strings are written) and the crash site (empty strings that already exist in the database are handled gracefully rather than crashing the page). The write-path fix prevents new occurrences, while the read-path fix ensures existing data with `solution = ''` doesn't crash the page.

---
