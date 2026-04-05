## TL;DR
An overly-broad try-catch in the issue-solver worker silently swallows `solveIssue` failures, leaving runs permanently stuck in PROCESSING status; when these zombie runs are later re-queued (or the job is retried by BullMQ), the corresponding MongoDB document may no longer exist, producing the "Issue solver run not found" error.

## What Broke and Why

The error originates from `findIssueSolverRunByRunId` in `mewtwo/src/mongodb/services/issue-solver-run.service.ts` (line 146), which throws when no `IssueSolverRun` document exists for the given `runId`. This function is called in two places during job processing:

1. **Line 70 of `issue-solver.worker.ts`** — the first lookup, **outside** the try-catch block.
2. **Line 32 of `services/issue-solver/index.ts`** (inside `solveIssue`) — a redundant second lookup, **inside** the try-catch block.

The critical bug is the **scope of the try-catch block** in `issue-solver.worker.ts` (lines 73–113). The comment on line 72 says `// Update the run with the Braintrust metadata`, and the catch on line 108 logs `"Failed to update Braintrust metadata for run"` — but the try block actually wraps **three unrelated operations**:

```
try {
    await updateIssueSolverRunWithBraintrustMetadata(...)  // ← intended
    await setIssueSolverRunStatus(runId, RunStatus.PROCESSING)  // ← NOT intended
    await solveIssue(runId, { ... })  // ← NOT intended (this is the entire solver!)
} catch (error) {
    Sentry.captureException(error);
    foam.captureException(error);
    log().error(`Failed to update Braintrust metadata for run ${runId}:`, error);
    // Error is SWALLOWED — job completes "successfully" from BullMQ's perspective
}
```

**The causality chain:**

1. A foam issue with `serviceId: "eval"` triggers `triggerSolverForFoamIssue`, which correctly inserts an `IssueSolverRun` document into MongoDB and then adds a job to the BullMQ `issue-solver-queue`.

2. The issue-solver worker picks up the job. Line 70 (`findIssueSolverRunByRunId`) succeeds — the document exists. The try block begins.

3. `setIssueSolverRunStatus(runId, RunStatus.PROCESSING)` updates the run to PROCESSING.

4. `solveIssue(runId, ...)` is called. Inside it, `findIssueSolverRunByRunId` is called **again** (redundant second lookup). The solver (`runDeepResearch5PhasesAgent`) runs the AI agent, which can fail for many reasons (timeout, model error, resource limits, etc.).

5. When `solveIssue` fails, the error is **caught and swallowed** by the overly-broad catch block. BullMQ marks the job as completed. The run status remains **permanently stuck at PROCESSING** — the `failed` event handler never fires, so the run is never marked as FAILED.

6. Over time, these zombie PROCESSING runs accumulate. They may be cleaned up by database maintenance, admin intervention, or the `restart-stuck-runs.ts` script may re-queue them after partial cleanup.

7. When a re-queued job (or a BullMQ retry with `attempts: 2`) is processed and the MongoDB document no longer exists, `findIssueSolverRunByRunId` at line 70 throws the observed error: `"Issue solver run not found for runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76"`.

8. As a secondary issue, the `worker.on('failed')` handler (line 136) tries to call `setIssueSolverRunStatus(job.data.runId, RunStatus.FAILED)`, which also throws when the document doesn't exist (line 57 of the service), causing an unhandled exception in the event handler.

## Fix

**1. Narrow the try-catch to only wrap Braintrust metadata updates** (`issue-solver.worker.ts` lines 69–114):

```typescript
await withRequestContext(context, async () => {
    const run = await findIssueSolverRunByRunId(runId);

    // Update the run with the Braintrust metadata (non-critical, safe to catch)
    try {
        const braintrustUrl = await getBraintrustUrl();
        const braintrustRootSpanId = getBraintrustRootSpanId();
        await updateIssueSolverRunWithBraintrustMetadata(
            runId,
            braintrustUrl,
            braintrustRootSpanId,
        );
        log().info(
            `Updated run ${runId} with Braintrust metadata: URL=${braintrustUrl}, RootSpanId=${braintrustRootSpanId}`,
        );
    } catch (error) {
        Sentry.captureException(error);
        foam.captureException(error);
        log().error(`Failed to update Braintrust metadata for run ${runId}:`, error);
    }

    // Critical path — errors must propagate to trigger BullMQ retry and failed handler
    await setIssueSolverRunStatus(runId, RunStatus.PROCESSING);
    log().info(`[IssueSolverStatus] Updated status for run ${runId}`, {
        status: RunStatus.PROCESSING,
        jobId: job?.id,
        runId: job?.data.runId,
    });
    logKPI(Step.ISSUE_SOLVER_PROCESSING, undefined, runId);

    await solveIssue(runId, {
        notificationsEnabled: false,
        model: ANTHROPIC_MODEL,
    });
});
```

**2. Guard the `failed` event handler** against missing documents (`issue-solver.worker.ts` lines 136–153):

```typescript
worker.on('failed', async (job, err) => {
    if (job?.data.runId) {
        try {
            await setIssueSolverRunStatus(job.data.runId, RunStatus.FAILED);
            logKPI(Step.ISSUE_SOLVER_FAILED, undefined, job.data.runId);
        } catch (statusError) {
            log().warn(`Could not update status to FAILED for run ${job.data.runId} (run may not exist)`, {
                originalError: err.message,
                statusError,
            });
        }
    }
    Sentry.captureException(err);
    foam.captureException(err);
    log().error(`Job ${job?.id} has failed with ${err.message}`);
});
```

**3. (Optional but recommended) Eliminate the redundant second DB lookup** by passing the already-fetched run document to `solveIssue`. The `IssueSolverOptions` type already has a `runDocument` field — use it in `services/issue-solver/index.ts`:

```typescript
export default async function solveIssue(
    runId: string,
    options: IssueSolverOptions = { ... },
): Promise<IssueSolverReturn> {
    await ensureStatsigInitialized();
    initLogger({ projectName: ISSUE_SOLVER_PROJECT_NAME });

    const run = options.runDocument ?? await findIssueSolverRunByRunId(runId);
    // ... rest of function
```

Then in the worker, pass the run: `await solveIssue(runId, { notificationsEnabled: false, model: ANTHROPIC_MODEL, runDocument: run });`
