[Foam Trace ID: 3aea2b73829f2cc16e6473acee01ca05] ## TL;DR

The Sentry webhook handler for issue processing calls `findSentryProjectByProjectId` twice with identical parameters — once as an early eligibility filter (succeeds), then again 12.5 seconds later inside `buildAndStoreIssueSolverRun` (fails). During the intervening window (occupied by S3 uploads, LLM grouping, and API calls), a concurrent external operation deleted or modified the Project document from MongoDB. The second lookup throws an unhandled error because the pipeline does not pass the already-validated project data forward, and `buildAndStoreIssueSolverRun` has no graceful handling for a project that disappears mid-request.

## What Broke and Why

A Sentry `issue.created` webhook arrived at `POST /sentry/webhook` for issue `7140600960` (shortId `FASTAPI-CLOUD-RUN-H9`) from company `longeye` with `installationId: 2169a967-cd48-4097-bcdc-e1bbcbf59631`.

**First project lookup succeeds (01:20:40.585):** Early in `handleIssue` (webhook.ts:269), the handler calls `findSentryProjectByProjectId(4509119107891200, "2169a967-...")` as an eligibility/filter gate. This succeeds — the log at `sentry.service.ts:279` confirms: `"Successfully found project 4509119107891200 for installation 2169a967-cd48-4097-bcdc-e1bbcbf59631"`. The issue is marked as `FOAM_SENTRY_WEBHOOK_ISSUE_NOT_FILTERED` and processing continues.

**12.5 seconds of intervening work:** The handler then performs S3 storage of issue data (01:20:40.586–42.015), a ~10-second LLM call to Google for issue grouping (01:20:42.059–51.878), and issue buffer operations (01:20:51.889–52.292).

**Pipeline queued without project data:** At 01:20:52.293, `runIssueSolverPipeline` is queued at webhook.ts:437 with only `{issueId: '7140600960', customerId: '6896656a8a9ec1414e104c44', shortId: 'FASTAPI-CLOUD-RUN-H9'}` — critically, the **already-validated project data is not passed** through the pipeline.

**Second project lookup fails (01:20:53.093):** Inside `buildAndStoreIssueSolverRun` (factory.ts:158), the code re-fetches the issue from the Sentry API (`GET /api/0/issues/7140600960/`), extracts `project.id: 4509119107891200`, and calls `findSentryProjectByProjectId` again with the **identical parameters**. This time, the MongoDB query returns null, and the function throws at `sentry.service.ts:259`:

```
Error: Sentry projectId: 4509119107891200 not found for company: longeye with installationId: 2169a967-cd48-4097-bcdc-e1bbcbf59631
```

Both calls go through `mongoose.connection.withSession()`, which creates independent sessions with default settings (no transaction, no snapshot isolation). Each session's `Project.findOne` sees the current state of the database at query time. The telemetry confirms **zero write operations to the Project collection within this trace** — no delete, update, or modify. The 48 log entries and 20 visible sibling spans (of 81) contain no Project mutation operations.

**The Project document was deleted by a concurrent external operation** during the 12.5-second window between the two lookups. This could be a concurrent Sentry `installation` webhook (e.g., project removal/resync), a background job, or an admin operation — the responsible process has its own separate trace not captured in this telemetry. The lock held during processing (`Lock.save` at 01:20:40.493, released at 01:20:53.092) protects against duplicate processing of the *same issue*, but does not protect the Project document from modification by other webhook types or operations.

**Alternative hypothesis considered and eliminated:** MongoDB session/transaction isolation causing stale reads. This was ruled out because: (a) both calls use `withSession()` with no options, creating default sessions that inherit connection-level read preference (default: `primary`), (b) with `readConcern: 'local'` (default), both reads see the latest committed data on the primary, and (c) even with `secondaryPreferred`, 12.5 seconds of replication lag would be extremely anomalous. The simplest explanation — a concurrent deletion of the Project document — fully accounts for the evidence.

## Fix

**Pass the already-validated project data through the pipeline** instead of performing a redundant second lookup. In `handleIssue` (webhook.ts), the first successful call to `findSentryProjectByProjectId` at ~line 269 already retrieves the Project document. This result should be passed as a parameter when queuing `runIssueSolverPipeline` at line 437, and threaded through `runSolverPipeline` (line 505) into `buildAndStoreIssueSolverRun` (factory.ts:158), eliminating the need for the second database lookup entirely.

This fix breaks the causal chain at the exact point of failure: `buildAndStoreIssueSolverRun` would no longer query MongoDB for a Project document that may have been concurrently deleted. Instead, it would use the project data that was already validated and retrieved at the start of the request.

**Additionally**, as a defense-in-depth measure, `buildAndStoreIssueSolverRun` should gracefully handle the case where a project lookup fails (if the redundant lookup cannot be fully eliminated for other code paths). Instead of throwing an unhandled error, it should log a warning and abort the solver run creation cleanly, since the project no longer exists and there's nothing to solve against.

---
