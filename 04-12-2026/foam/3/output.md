[Foam Trace ID: b65d3fee5c90c2eec84d24454dfba5b2] ## TL;DR

Sentry webhooks for project `4509119107891200` belonging to customer `longeye` (installationId `2169a967-cd48-4097-bcdc-e1bbcbf59631`) are failing because that project was never registered in the app's MongoDB `project` collection. The write path for project registration requires an explicit human-initiated API call (`POST /onboarding/create-project` or `POST /customer/project`) and is never triggered automatically — so when `buildAndStoreIssueSolverRun` queries the database for the project, it finds nothing and throws. The fix is for the `longeye` customer to register project `4509119107891200` via the project creation endpoint.

---

## What Broke and Why

### Causal Chain

**1. Sentry sends a webhook for an unregistered project.**
Sentry delivers an `issue.created` event to `POST /sentry/webhook` for issue `7140600960` (shortId `FASTAPI-CLOUD-RUN-H9`). This issue belongs to Sentry project `4509119107891200`. The `longeye` Sentry integration (`installationId: 2169a967-cd48-4097-bcdc-e1bbcbf59631`) is fully authenticated and recognized — the top-level `sentry` collection document exists and is found successfully.

**2. The solver pipeline fetches the project ID from the Sentry API.**
Inside `buildAndStoreIssueSolverRun` (`factory.ts:158`), the code makes a live Sentry API call to get issue details:
```typescript
const issueDetails = await sentryClient.getIssueDetails('7140600960');
const projectId = (issueDetails.project as Record<string, string>).id;
// → '4509119107891200'
```
This `projectId` (from the live API response) is then used to look up the customer's stored project configuration in MongoDB.

**3. The MongoDB lookup finds nothing — the project was never registered.**
`findSentryProjectByProjectId` runs:
```typescript
return await SentryProject.findOne({ installationId, projectId })
    .sort({ createdAt: -1 })
    .session(this.session);
```
This query returns `null` because no document with `{ installationId: '2169a967-cd48-4097-bcdc-e1bbcbf59631', projectId: '4509119107891200' }` exists in the `project` collection. The function then throws:
```
Error: Sentry projectId: 4509119107891200 not found for company: longeye
       with installationId: 2169a967-cd48-4097-bcdc-e1bbcbf59631
```

**4. Why the project was never registered.**
The Sentry OAuth install flow (`POST /account/link-sentry-and-customer`) only creates a top-level `sentry` document with OAuth credentials and org metadata. It **never fetches the customer's Sentry project list and never writes to the `project` collection**. Project registration is a separate, explicit, manual step requiring a call to either:
- `POST /onboarding/create-project` — onboarding wizard path
- `POST /customer/project` — self-service path

Both require the caller to supply `projectId` + a GitHub `repoOwner`/`repoName` mapping. If a project is skipped during onboarding, or added to the customer's Sentry org *after* onboarding, it simply never lands in MongoDB. Telemetry confirms this has failed identically across **6 consecutive webhook deliveries** for this installation on 2025-12-25 with zero successful completions — the project document has never existed.

**5. The misleading "success" log at `sentry.service.ts:279`.**
Telemetry initially appeared to show a *successful* project lookup at `sentry.service.ts:279` for the same projectId. Investigation revealed this is a **logging bug**: `safeFindSentryProjectByProjectId` logs `"Successfully found project…"` unconditionally *outside* the null-check, so it fires even when the query returns `null`:
```typescript
const project = await sentryProjectCollection.findSentryProjectByProjectId(installationId, projectId);
log().info(`Successfully found project ${projectId} for installation ${installationId}`); // ← fires even if project is null!
return project; // ← returns null silently
```
Both service functions execute the **same** `findOne({ installationId, projectId })` query. Both return `null` for this projectId. The difference is purely in error handling: `safeFindSentryProjectByProjectId` silently returns `null` (used for a non-fatal filter check), while `findSentryProjectByProjectId` throws. The log at line 279 is a red herring — there is no data inconsistency between the two paths.

---

## Fix

### Immediate Fix — No Code Changes Required

The root cause is operational: project `4509119107891200` was never registered for the `longeye` customer's Sentry installation. The customer (or a Foam operator on their behalf) must register the project by calling:

**`POST /customer/project`** (authenticated as the `longeye` customer):
```json
{
  "projectId": "4509119107891200",
  "repoOwner": "<github-org>",
  "repoName": "<github-repo>"
}
```
Or equivalently via the onboarding endpoint:

**`POST /onboarding/create-project`**:
```json
{
  "customerId": "6896656a8a9ec1414e104c44",
  "project": {
    "projectId": "4509119107891200",
    "repoOwner": "<github-org>",
    "repoName": "<github-repo>"
  }
}
```

Once this document is written to the `project` collection with `{ installationId: '2169a967-cd48-4097-bcdc-e1bbcbf59631', projectId: '4509119107891200' }`, `findSentryProjectByProjectId` will return the document and the error will stop occurring for all subsequent webhooks from this project.

---

### Secondary Code Fix — Log Bug in `safeFindSentryProjectByProjectId`

The unconditional success log in `safeFindSentryProjectByProjectId` should be moved inside the null-check to avoid misleading telemetry:

```typescript
// sentry.service.ts — fix for safeFindSentryProjectByProjectId
const project = await sentryProjectCollection.findSentryProjectByProjectId(installationId, projectId);
if (project) {
    log().info(`Successfully found project ${projectId} for installation ${installationId}`);
} else {
    log().warn(`Project ${projectId} not found for installation ${installationId}`);
}
return project;
```

This does not affect the failure but prevents future false-positive "success" log entries from masking missing-project conditions during investigation.

---

### Preventive Enhancement (Optional)

To prevent this class of failure for future customers, consider adding a guard in the webhook pipeline that either:
1. Rejects or silently skips incoming webhooks for unregistered projects with a clear, non-fatal warning log (rather than throwing a fatal error), or
2. On first receipt of a webhook from an unregistered project, automatically calls the Sentry API to fetch project metadata and prompts the customer to complete registration (e.g., by providing the missing GitHub repo mapping).


---
