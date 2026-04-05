## TL;DR

Sentry webhook processing for company "longeye" crashed because project `4509119107891200` was never registered in MongoDB via the manual onboarding flow (`POST /onboarding/create-project`). The system has no automatic project sync mechanism — projects must be explicitly onboarded one-by-one — and the webhook's critical path (`buildAndStoreIssueSolverRun`) uses a hard-throwing lookup that fatally crashes on unregistered projects instead of gracefully skipping them.

## What Broke and Why

### The Trigger
A Sentry `issue.created` webhook arrived for issue `FASTAPI-CLOUD-RUN-H9` (ID `7140600960`) belonging to project `4509119107891200` under company "longeye" (installationId `2169a967-cd48-4097-bcdc-e1bbcbf59631`).

### Root Cause: No Automatic Project Registration
Sentry projects are **only** stored in the `SentryProject` MongoDB collection through explicit, manual API calls during onboarding:

- `POST /onboarding/create-project` — an internal API protected by `FOAM_INTERNAL_API_TOKEN`
- A UI-driven flow in `/pages/customer.ts`

When a Sentry app is installed (`insertSentry` at `sentry.service.ts:110`), only the account-level `SentryDocument` (with installationId, orgSlug, tokens) is created. **Individual projects are never automatically discovered or synced.** There is no background job, scheduled task, or webhook handler that enumerates a customer's Sentry projects and registers them. The `onboarding-health-check` endpoint detects missing projects but is read-only — it logs warnings but does not create records.

This means project `4509119107891200` was either:
- Never included in the initial onboarding for "longeye", or
- Created in Sentry after the initial onboarding was completed

Either way, no `SentryProjectDocument` with `{ installationId: "2169a967-cd48-4097-bcdc-e1bbcbf59631", projectId: "4509119107891200" }` exists in MongoDB.

### The Crash Path
The webhook handler processes the issue through this call chain:

1. **`handleIssue`** (`webhook.ts:308`) — extracts `projectId` from webhook payload, calls `safeFindSentryProjectByProjectId` for pre-filtering (soft-fail, returns `null`)
2. **`runIssueSolverPipeline`** → **`runSolverPipeline`** (`webhook.ts:443, 505`) — queues the solver pipeline; notably does **not** pass `projectId` forward
3. **`buildAndStoreIssueSolverRun`** (`factory.ts:158`) — independently re-fetches issue details from the Sentry API, extracts `projectId`, then calls the **hard-throwing** `findSentryProjectByProjectId`:

```typescript
const issueDetails = await sentryClient.getIssueDetails(sentryIssueId);
const projectId = (issueDetails.project as Record<string, string>).id;
const sentryProject = await findSentryProject(
    sentryDocument.installationId,
    projectId,
    customerDocument.companyName,
);
```

4. **`findSentryProjectByProjectId`** (`sentry.service.ts:252`) executes `SentryProject.findOne({ installationId, projectId })`, gets `null`, and throws:

```typescript
if (!project) {
    throw new Error(
        `Sentry projectId: ${projectId} not found for company: ${companyName} with installationId: ${installationId}`,
    );
}
```

5. **No intermediate error handling exists** — `runSolverPipeline`, `runIssueSolverPipeline`, and `handleIssue` have no try/catch blocks. The error propagates to the Express error middleware, which returns HTTP 500 to Sentry.

### Design Asymmetry
The system already has `safeFindSentryProjectByProjectId` (returns `null` instead of throwing), used in the health-check endpoint and the `shouldIgnoreStackTrace` pre-filter. But the critical pipeline path uses the throwing variant, making unregistered projects a fatal, run-terminating error.

### Secondary Bug: Misleading Success Log
The telemetry initially appeared contradictory — the project was "successfully found" at `01:20:40.585` but then "not found" at `01:20:53.093`. This is explained by a bug in `safeFindSentryProjectByProjectId` (line 279):

```typescript
// safeFindSentryProjectByProjectId:
const project = await sentryProjectCollection.findSentryProjectByProjectId(installationId, projectId);
log().info(`Successfully found project ${projectId} for installation ${installationId}`);  // ALWAYS logs, even when project is null!
return project;
```

The success log is emitted **unconditionally** — even when the query returns `null`. The project was never in the database; the first "success" was a false positive.

### Alternative Hypotheses Eliminated
- **Race condition / data deleted between lookups**: Ruled out — the `safeFindSentryProjectByProjectId` log was a false positive; both lookups returned `null`.
- **Type mismatch (numeric vs string projectId)**: Ruled out — both the Zod webhook schema and the Sentry API response define `project.id` as a string, matching the schema's `projectId: string`.
- **Query parameter difference between safe/unsafe variants**: Ruled out — both call the identical `sentryProjectCollection.findSentryProjectByProjectId(installationId, projectId)` method.

## Fix

### Primary Fix: Auto-register unknown Sentry projects during webhook processing

In `buildAndStoreIssueSolverRun` (`factory.ts`), replace the hard-throwing `findSentryProjectByProjectId` with logic that auto-creates the `SentryProject` document when it's missing, using the issue details already fetched from the Sentry API:

```typescript
const issueDetails = await sentryClient.getIssueDetails(sentryIssueId);
const projectId = (issueDetails.project as Record<string, string>).id;
let sentryProject = await safeFindSentryProjectByProjectId(
    sentryDocument.installationId,
    projectId,
);
if (!sentryProject) {
    // Auto-register the project from Sentry API data
    sentryProject = await insertSentryProject({
        installationId: sentryDocument.installationId,
        projectId,
        name: issueDetails.project.name,
        orgSlug: sentryDocument.orgSlug,
        platform: issueDetails.project.platform || 'unknown',
        repository: { repoOwner: '', repoName: '' }, // Requires manual mapping later
    });
    log().warn(`Auto-registered missing Sentry project ${projectId} for installation ${sentryDocument.installationId}`);
}
```

If auto-registration is not feasible (e.g., `repository` mapping is required and cannot be defaulted), then at minimum the error should be caught and the webhook gracefully skipped with a warning log rather than crashing with HTTP 500.

**Why this fixes the root cause**: The causal chain is: webhook arrives → projectId not in DB → hard throw → HTTP 500. The fix eliminates the "projectId not in DB" state by auto-registering the project, or at minimum eliminates the "hard throw" step so unregistered projects don't crash the pipeline. This addresses the root cause (no project sync mechanism) rather than just the symptom (the crash).

### Secondary Fix: Fix misleading log in `safeFindSentryProjectByProjectId`

In `sentry.service.ts`, guard the success log with a null check:

```typescript
const project = await sentryProjectCollection.findSentryProjectByProjectId(installationId, projectId);
if (project) {
    log().info(`Successfully found project ${projectId} for installation ${installationId}`);
}
return project;
```

This prevents false-positive "success" logs that complicate debugging.

---