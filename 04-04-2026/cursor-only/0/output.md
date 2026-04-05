## TL;DR
The backend API returns `solution: ''` (empty string) for issues without a completed solver run, and a recently-added frontend guard (`88751b2a`) throws an unrecoverable error on that empty string, crashing the issue details page.

## What Broke and Why
The causality chain spans both the backend (mewtwo) and frontend (porygon):

1. **Backend produces empty string for unsolved issues.** In `mewtwo/src/routers/issues.ts` (line 82–83), when a user requests a specific issue, the router looks up the latest solution S3 URL via `findLatestSolutionS3URLByFoamIssueId`. If no completed solver run exists for the issue (i.e., the issue hasn't been solved yet), `solutionS3URL` is `null`, and the ternary falls through to the default value of `''` (empty string):
   ```typescript
   const solutionS3URL = await findLatestSolutionS3URLByFoamIssueId(issue._id);
   const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : '';
   ```
   This empty string is then set as `solution: solutionText` on the response payload (line 94).

2. **Frontend guard throws on empty string.** Commit `88751b2a` ("One simple baby eval and another decent eval (#206)") added a new check in `porygon/app/(platform)/issues/[issueId]/page.tsx` (lines 55–58) that throws an unrecoverable server-side error whenever the solution is exactly an empty string:
   ```typescript
   if (issue.solution === '') {
     throw new Error(`Issue ${issueId} has an empty solution string`);
   }
   ```
   This causes a crash for **every issue that hasn't been solved yet**, since the backend always returns `solution: ''` for those.

3. **The downstream component already handles this gracefully.** `IssueDetailsPage` (line 37) conditionally renders the solution card with `'solution' in issue && issue.solution`, which evaluates to `false` for both `undefined` and `''`. The throw in the page component is redundant and destructive — it prevents the page from rendering at all for a perfectly valid state (an unsolved issue).

## Fix
**Two changes, both in the same data flow:**

1. **Backend — `mewtwo/src/routers/issues.ts`**: Return `undefined` instead of `''` when no solution exists. Also make the `solution` field optional in the `FormattedIssue` interface to match the frontend type (`solution?: string`).

   ```typescript
   // Line 48: make solution optional
   interface FormattedIssue {
     // ... other fields ...
     solution?: string;
   }

   // Line 83: change fallback from '' to undefined
   const solutionText = solutionS3URL ? await getFromS3UrlAsText(solutionS3URL) : undefined;
   ```

2. **Frontend — `porygon/app/(platform)/issues/[issueId]/page.tsx`**: Remove the throw guard (lines 55–58) entirely. An issue without a solution is a normal state, not an error condition. The `IssueDetailsPage` component already handles this by simply not rendering the solution card.

   Remove:
   ```typescript
   // Throw exception if solution is empty string (not null or non-empty)
   if (issue.solution === '') {
     throw new Error(`Issue ${issueId} has an empty solution string`);
   }
   ```
