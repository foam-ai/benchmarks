## TL;DR
The webhook handler processes Sentry issue events from unconfigured projects (not onboarded in the database), and `buildAndStoreIssueSolverRun` calls `findSentryProjectByProjectId` which throws instead of handling the missing project gracefully.

## What Broke and Why

**Error**: `Sentry projectId: 4508179721224192 not found for company: foam with installationId: 11231aa2-d43b-46e9-a09b-9ad47c60ea3b`

**Causality chain**:

1. A Sentry webhook fires for an issue belonging to Sentry project `4508179721224192` in customer "foam"'s organization. Sentry sends webhooks for **all** projects in the organization, not just the ones the customer has onboarded/configured in the app.

2. The webhook handler in `src/routers/sentry/webhook.ts` (`handleIssue`, line 206) extracts the `projectId` from the payload (line 218: `payload.data.issue.project.id`). It performs severity checks, project filter checks, and stacktrace ignore checks — but **none of these verify that the Sentry project actually exists in the app's database** (`SentryProject` collection).

3. The `shouldIgnoreStackTrace` function (line 55) does call `safeFindSentryProjectByProjectId`, which returns `null` for unconfigured projects. However, when the project is null, it returns `{ shouldIgnore: false }` — meaning processing **continues** for unconfigured projects rather than stopping.

4. The handler proceeds to store the issue to S3, then tries the issue grouper via `tryIssueGrouper` → `processIssueGroupingWithTransaction` → `processIssueGrouping` → `processAssociations` → `createAndLinkRunToGroups` → `runSolverPipeline` → `buildAndStoreIssueSolverRun`.

5. In `buildAndStoreIssueSolverRun` (`src/services/issue-solver/factory.ts`, line 156-162), the function fetches issue details from the Sentry API, extracts `projectId`, and calls `findSentryProjectByProjectId(sentryDocument.installationId, projectId, customerDocument.companyName)`.

6. `findSentryProjectByProjectId` in `src/mongodb/services/sentry.service.ts` (line 258) **throws** when the project is not found in the database, unlike its sibling `safeFindSentryProjectByProjectId` (line 268) which returns `null`.

7. This unhandled error propagates up the entire call chain with no try/catch at any level, producing the Sentry error with 2,863 occurrences since Oct 15, 2025.

**Key observation**: The codebase already has `safeFindSentryProjectByProjectId` and uses it correctly in other places (the webhook's `shouldIgnoreStackTrace`, and `src/services/issue-solver/index.ts` for ignore config checking). The problem is specifically that the solver pipeline path (`buildAndStoreIssueSolverRun`) uses the throwing variant, and no upstream code validates project existence before reaching it.

## Fix

Add a project existence check in the webhook handler's `handleIssue` function, after extracting the `projectId`, using the existing `safeFindSentryProjectByProjectId`. If the project is not configured in the database, skip processing and return 202:

**In `src/routers/sentry/webhook.ts`, after line 218** (`const projectId = payload.data.issue.project.id;`):

```typescript
// Verify the Sentry project is configured before processing
const sentryProject = await safeFindSentryProjectByProjectId(
    payload.installation.uuid,
    projectId
);
if (!sentryProject) {
    log().info('Sentry project not configured in database, skipping issue processing', {
        projectId,
        installationId: payload.installation.uuid,
        issueId,
        companyName: customer.companyName,
    });
    res.sendStatus(202);
    return;
}
```

This is the correct fix because:
- `safeFindSentryProjectByProjectId` is already imported in the webhook file (line 32)
- It prevents all downstream processing (S3 storage, LLM-based issue grouping, solver pipeline) for projects that can never succeed
- It follows the existing pattern used elsewhere in the codebase
- The solver pipeline fundamentally cannot proceed without a configured project (it needs `repoOwner`/`repoName` from the project to create a GitHub client)
- This eliminates all 2,863+ error occurrences without changing the behavior for properly configured projects

---
