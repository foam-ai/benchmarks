[Foam Trace ID: b5cf6e8e2f88dd5def2bf8fd6cec2b3c] ## TL;DR

The Sentry project `4509119107891200` for the `longeye` installation was never written to the `project` collection, so `findSentryProjectByProjectId` returns `null` and `buildAndStoreIssueSolverRun` throws; registration requires an explicit `POST /customer/project` that was never made.

## What Broke and Why

**Observed error:** `Error: Sentry projectId: 4509119107891200 not found for company: longeye`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** The webhook is authenticated and the top-level `sentry` document for the installation is found.

**2.** `buildAndStoreIssueSolverRun` fetches the issue from the Sentry API, reads `project.id`, and queries MongoDB for `{ installationId, projectId }` — nothing matches.

**3.** The OAuth install flow only creates the `sentry` document; projects are registered separately during onboarding, and this project was skipped or added later.

**4.** A misleading 'Successfully found project' log fires unconditionally in `safeFindSentryProjectByProjectId`.

## Fix

- Register the project via `POST /customer/project` (operational fix, no code change required).
- Move the success log inside the null check and downgrade unregistered-project webhooks to a warning.


---
