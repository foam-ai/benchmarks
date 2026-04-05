## TL;DR
The Sentry webhook pipeline crashes with a hard throw when a Sentry project (projectId `4509119107891200`) hasn't been onboarded into the database for customer "longeye", because `findSentryProjectByProjectId` throws instead of gracefully handling missing projects.

## What Broke and Why

The causality chain is:

1. **Sentry sends a webhook** for a new issue belonging to project `4509119107891200` under customer "longeye" (installationId `2169a967-cd48-4097-bcdc-e1bbcbf59631`).

2. **The webhook handler** (`webhook.ts:183`) processes the issue via `handleIssue` → `runIssueSolverPipeline` → `runSolverPipeline` → `buildAndStoreIssueSolverRun`.

3. **Inside `buildAndStoreIssueSolverRun`** (`factory.ts:156–162`), the code fetches the issue details from the Sentry API, extracts the `projectId` from the issue response, and then calls `findSentryProjectByProjectId(installationId, projectId, companyName)` to look up the project in MongoDB.

4. **`findSentryProjectByProjectId`** (`sentry.service.ts:246–266`) queries the `SentryProject` collection for a document matching `{ installationId, projectId }`. When no document is found, it **throws a hard error** rather than returning null.

5. **The project is missing from the database** because Sentry projects are only persisted during onboarding — either via the `/project` POST endpoint in `pages/customer.ts` or via the `/create-project` endpoint in `routers/onboarding/index.ts`. Both require an explicit manual action by the customer or an admin to register each project. If a customer adds a new Sentry project (or if their Sentry organization has projects that were never individually onboarded), those projects won't exist in the database, but Sentry will still send webhooks for issues in those projects.

6. **There is no automatic project sync** in the webhook flow. The webhook handler does not attempt to discover or create missing projects on the fly. The `safeFindSentryProjectByProjectId` variant (which returns `null` instead of throwing) exists and is already used in the earlier `shouldIgnoreStackTrace` step and elsewhere, but the critical path in `buildAndStoreIssueSolverRun` uses the throwing variant `findSentryProjectByProjectId`.

In summary: customer "longeye" has a Sentry project (`4509119107891200`) that sends issues via webhooks, but that project was never registered in the database during onboarding. The pipeline crashes because it expects every webhook-producing project to already exist in the database, with no fallback or auto-registration.

## Fix

**Option A (Recommended — auto-sync missing projects on demand):** In `buildAndStoreIssueSolverRun` (`factory.ts`), replace the hard-failing `findSentryProjectByProjectId` call with logic that attempts to fetch and insert the missing project from the Sentry API when it's not found in the database:

```typescript
// In factory.ts, around lines 156-162, replace:
const sentryProject = await findSentryProject(
    sentryDocument.installationId,
    projectId,
    customerDocument.companyName,
);

// With:
import { safeFindSentryProjectByProjectId, insertSentryProject } from '../../mongodb/services/sentry.service';

let sentryProject = await safeFindSentryProjectByProjectId(
    sentryDocument.installationId,
    projectId,
);

if (!sentryProject) {
    log().warn(
        `Sentry project ${projectId} not found in DB for company ${customerDocument.companyName}, attempting auto-sync`,
    );
    const projectDetails = await sentryClient.getProjectDetails(
        sentryDocument.orgSlug,
        projectId,
    );
    const newProjectDoc = {
        _id: new mongoose.Types.ObjectId(),
        installationId: sentryDocument.installationId,
        projectId,
        name: projectDetails.name,
        slug: projectDetails.slug,
        orgSlug: sentryDocument.orgSlug,
        platform: projectDetails.platform || 'unknown',
        repository: { repoOwner: '', repoName: '' },
    } as SentryProjectDocument;
    await insertSentryProject(newProjectDoc);
    sentryProject = newProjectDoc;
}
```

Then add a downstream check: if `sentryProject.repository.repoOwner` and `sentryProject.repository.repoName` are empty (because the auto-synced project hasn't been linked to a repo yet), throw a descriptive error or skip the run gracefully, since the solver requires a GitHub repo to operate.

**Option B (Minimal — fail gracefully):** Switch the `findSentryProjectByProjectId` call in `factory.ts` to use `safeFindSentryProjectByProjectId` (which returns `null`) and handle the `null` case by logging a warning and returning early instead of crashing the entire pipeline:

```typescript
const sentryProject = await safeFindSentryProjectByProjectId(
    sentryDocument.installationId,
    projectId,
);
if (!sentryProject) {
    log().warn(
        `Sentry project ${projectId} not found for company ${customerDocument.companyName} — skipping run (project not onboarded)`,
    );
    throw new Error(
        `Sentry project ${projectId} not onboarded for company ${customerDocument.companyName}. Please onboard this project first.`,
    );
}
```

This at least provides a clearer error message and allows the caller to decide whether to surface it or handle it gracefully.

**Option A is preferred** because it eliminates the class of errors entirely by auto-registering projects on first webhook, matching the pattern already used in `pages/customer.ts` for manual onboarding.
