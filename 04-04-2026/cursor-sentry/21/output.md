## TL;DR
The worker processes a BullMQ job where `job.data.runId` is `undefined`, and neither the worker nor `findIssueSolverRunByRunId` validates the input — causing an empty MongoDB query `{}` that returns null, then throws. A secondary bug: `solveIssue()` is inside a try/catch meant only for Braintrust metadata errors, silently swallowing solver failures.

## What Broke and Why

**The error chain:**

1. The issue-solver worker (`issue-solver.worker.ts:64`) extracts `runId` from `job.data.runId` without validation. For BullMQ job 3922, `job.data.runId` was `undefined`.

2. The undefined `runId` is passed to `findIssueSolverRunByRunId(undefined)` (`issue-solver.worker.ts:70`), which constructs a Mongoose query `{ runId: undefined }`.

3. Mongoose strips `undefined` values from query filters, resulting in an empty filter `{}`. The Sentry breadcrumbs confirm this: `Finding IssueSolverRun with filter: {}` → `Found IssueSolverRun: null`.

4. Since no document is found, the function throws: `Issue solver run not found for runId: undefined`.

5. This error is **outside** the worker's try/catch block (which starts at line 73), so it propagates to BullMQ, which marks the job as failed and fires the `failed` event where `Sentry.captureException` is called.

**Why was `runId` undefined?**

All three code paths that enqueue to `issue-solver-queue` properly include `runId`:
- `foam-issue-solver-trigger.service.ts:138-140` — passes `{ runId }` (from `uuidv4()`)
- `restart-stuck-runs.ts:206` — passes `{ runId: run.runId }` (from MongoDB document)
- `reprocess-foam-issues.ts:43-45` — passes `{ runId }` (from `uuidv4()`)

Since all current producers are correct, the job with undefined `runId` was most likely enqueued by a prior code version with a different data format, or by a manual Redis/BullMQ operation. The error occurred only twice (first seen 2026-02-02T01:35:34Z, last seen 2026-02-02T01:36:13Z) and then stopped, supporting this theory.

**Secondary bug — silent solver failure swallowing:**

In the worker, `solveIssue(runId)` at line 101 is **inside** a try/catch block (lines 73–113) whose comment says `// Log the error but don't fail the job for this`. This try/catch was designed to handle non-critical Braintrust metadata update failures, but `solveIssue` was placed inside it. Consequences:
- If the solver throws, the error is caught and only logged as a "Braintrust metadata" failure
- BullMQ considers the job "completed" (error is not re-thrown)
- The run status remains stuck at `PROCESSING` (set at line 92, never updated to `FAILED`)
- BullMQ retries are never triggered for solver failures
- Runs get permanently stuck in `PROCESSING` state

## Fix

**Fix 1 — Validate `runId` in the worker** (`issue-solver.worker.ts`):

```typescript
const runId = job.data.runId;
if (!runId) {
    throw new Error(`Job ${job.id} missing runId in job data: ${JSON.stringify(job.data)}`);
}
```

Add this after line 64, before the `runId` is used anywhere. This fails fast with a clear, actionable error message instead of making an empty MongoDB query.

**Fix 2 — Validate input in `findIssueSolverRunByRunId`** (`issue-solver-run.service.ts`):

```typescript
export async function findIssueSolverRunByRunId(runId: string): Promise<IssueSolverRunDocument> {
    if (!runId) {
        throw new Error('findIssueSolverRunByRunId requires a non-empty runId');
    }
    // ... rest of function unchanged
}
```

This is a defense-in-depth guard preventing any caller from making an empty MongoDB query.

**Fix 3 — Restructure error handling** (`issue-solver.worker.ts`):

Move `solveIssue` **outside** the Braintrust metadata try/catch so solver failures properly fail the BullMQ job and trigger retries:

```typescript
await withRequestContext(context, async () => {
    const run = await findIssueSolverRunByRunId(runId);

    // Non-critical: update Braintrust metadata
    try {
        const braintrustUrl = await getBraintrustUrl();
        const braintrustRootSpanId = getBraintrustRootSpanId();
        await updateIssueSolverRunWithBraintrustMetadata(runId, braintrustUrl, braintrustRootSpanId);
    } catch (error) {
        Sentry.captureException(error);
        foam.captureException(error);
        log().error(`Failed to update Braintrust metadata for run ${runId}:`, error);
    }

    // Critical: solve the issue — failures MUST propagate to fail the BullMQ job
    await setIssueSolverRunStatus(runId, RunStatus.PROCESSING);
    logKPI(Step.ISSUE_SOLVER_PROCESSING, undefined, runId);
    await solveIssue(runId, { notificationsEnabled: false, model: ANTHROPIC_MODEL });
});
```

---
