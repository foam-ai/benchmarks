## TL;DR
Sentry project `4509119107891200` was never registered in the database for company `longeye`, so the solver pipeline crashes when it tries to look up the project's repository configuration.

## What Broke and Why

**The Error Flow:**

A Sentry webhook arrived at `2025-12-25 01:20:40` for a new issue (`7140600960`) in company `longeye`'s Sentry project `4509119107891200` (installation `2169a967-cd48-4097-bcdc-e1bbcbf59631`). The webhook was processed through this chain:

1. **Webhook received** → customer found, eligibility checks pass
2. **`shouldIgnoreStackTrace`** calls `safeFindSentryProjectByProjectId` (line 64, `webhook.ts`) — this returns `null` because the project doesn't exist in MongoDB, but the code treats a missing project as "no ignore config" and **continues processing**
3. **Misleading log**: `safeFindSentryProjectByProjectId` (line 279, `sentry.service.ts`) always logs `"Successfully found project 4509119107891200..."` even when the result is null — a logging bug that masks the real problem
4. **Pipeline continues**: S3 storage, issue grouping, and LLM distillation all succeed (~12 seconds of processing)
5. **`runSolverPipeline`** calls `buildAndStoreIssueSolverRun` (`factory.ts:158`) which calls `findSentryProjectByProjectId` — the **throwing** version (line 259, `sentry.service.ts`)
6. **💥 Crash**: The project doesn't exist → throws `"Sentry projectId: 4509119107891200 not found for company: longeye with installationId: 2169a967-cd48-4097-bcdc-e1bbcbf59631"`

**Root Cause**: Projects must be manually registered via the onboarding/customer API endpoints (`POST /onboarding/create-project` or the customer dashboard). Company `longeye` has a valid Sentry installation and customer record, but this specific Sentry project was never onboarded into Foam's `project` collection. When Sentry sends webhooks for issues in unregistered projects, the webhook passes all early checks but crashes deep in the solver pipeline where the project's repository mapping (repoOwner/repoName) is required.

**Telemetry evidence** (trace `aa465a4a31a3c88ad7dbe8987ddd6537`):
- `01:20:40.585` — `safeFindSentryProjectByProjectId` misleadingly logs success (project was actually null)
- `01:20:40.586` — Pipeline continues despite missing project
- `01:20:52.430` — Sentry API call to get issue details succeeds
- `01:20:53.093` — `findSentryProjectByProjectId` throws because project `4509119107891200` not in DB
- Stack: `sentry.service.ts:259 → factory.ts:158 → webhook.ts:505 → webhook.ts:443 → webhook.ts:308`

## Fix

### Fix 1: Register the missing project (immediate data fix)
Register Sentry project `4509119107891200` for company `longeye` via the onboarding API or directly in MongoDB's `project` collection with the correct `installationId`, `projectId`, `name`, `orgSlug`, `platform`, and `repository` mapping.

### Fix 2: Fix misleading log in `safeFindSentryProjectByProjectId` (`sentry.service.ts:268-282`)

```typescript
// BEFORE (always logs success even when project is null):
export async function safeFindSentryProjectByProjectId(
    installationId: string,
    projectId: string,
): Promise<SentryProjectDocument | null> {
    const connection = await connectToDatabase();
    return await connection.withSession(async (session) => {
        const sentryProjectCollection = new SentryProjectCollection(session);
        const project = await sentryProjectCollection.findSentryProjectByProjectId(
            installationId,
            projectId,
        );
        log().info(`Successfully found project ${projectId} for installation ${installationId}`);
        return project;
    });
}

// AFTER (only logs success when actually found):
export async function safeFindSentryProjectByProjectId(
    installationId: string,
    projectId: string,
): Promise<SentryProjectDocument | null> {
    const connection = await connectToDatabase();
    return await connection.withSession(async (session) => {
        const sentryProjectCollection = new SentryProjectCollection(session);
        const project = await sentryProjectCollection.findSentryProjectByProjectId(
            installationId,
            projectId,
        );
        if (project) {
            log().info(`Successfully found project ${projectId} for installation ${installationId}`);
        } else {
            log().warn(`Project ${projectId} not found for installation ${installationId}`);
        }
        return project;
    });
}
```

### Fix 3: Add early project validation in `handleIssue` (`webhook.ts`, after line 262)

Add a check after `shouldIgnoreStackTrace` to verify the project exists before committing to the expensive pipeline:

```typescript
// After line 262 in webhook.ts, add early project existence check:
const sentryProjectExists = await safeFindSentryProjectByProjectId(
    payload.installation.uuid,
    projectId,
);
if (!sentryProjectExists && !forceRun) {
    log().warn('Webhook ignored - Sentry project not registered in database', {
        customerId: customer._id.toString(),
        companyName: customer.companyName,
        projectId,
        installationId: payload.installation.uuid,
        issueId,
    });
    res.status(200).json({
        message: 'Issue webhook ignored - project not registered',
        projectId,
    });
    return;
}
```

This prevents wasting ~13 seconds of processing (S3 storage, LLM calls for issue grouping) before ultimately crashing.

---
