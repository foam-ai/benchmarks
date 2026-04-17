[Foam Trace ID: 5484cfa62dad82526d59f42880e30580] ## TL;DR

The eval pipeline invokes `solveIssue(runId)` using a `runId` sourced from a historical/production dataset whose corresponding MongoDB document does not exist in the current environment's DB. Because `solveIssue` **always** re-fetches the run from MongoDB — even when the caller already has the document in memory — the `findOne({ runId })` returns `null` and throws `"Issue solver run not found for runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76"`. The fix is to refactor `solveIssue` to accept an optional pre-loaded `IssueSolverRunDocument`, allowing the eval harness to bypass the DB lookup entirely.

---

## What Broke and Why

### The Crash Site

The error is thrown in `/repo/mewtwo/src/mongodb/services/issue-solver-run.service.ts`:

```typescript
export async function findIssueSolverRunByRunId(runId: string): Promise<IssueSolverRunDocument> {
    const connection = await connectToDatabase();
    return await connection.withSession(async (session) => {
        const issueSolverRunColl = new IssueSolverRunCollection(session);
        const runDocument = await issueSolverRunColl.findIssueSolverRun({ runId });
        if (!runDocument) {
            throw new Error(`Issue solver run not found for runId: ${runId}`);
        }
        return runDocument;
    });
}
```

The MongoDB `findOne({ runId: "3daa8451-d9fa-4b72-b3f5-82e880115e76" })` returned `null`, which is confirmed by the span logs:

```
Finding IssueSolverRun with filter: {"runId":"3daa8451-d9fa-4b72-b3f5-82e880115e76"}
Found IssueSolverRun: null
```

### Why the Record Was Absent

This error occurred in the **eval service**, not the production BullMQ worker. The parent span in telemetry is:

```
eval.task.nyx-for-trajectory-evals-deep-research-5-phases/
  foam-mini-solver-terminal-velocity-failed-after-unavailable-memory
```

The eval task receives an `IssueSolverRunDocument` directly from its dataset as its `input`. This dataset document was sourced from a historical/production environment. The eval harness extracts `runId` from this document and calls:

```typescript
solveIssue(input.runId, options)
```

### The Design Flaw in `solveIssue`

`solveIssue` (`/repo/mewtwo/src/services/issue-solver/index.ts`) accepts **only a `runId: string`** — it has no parameter for a pre-loaded document. Its first substantive action is an **unconditional** DB re-fetch:

```typescript
export default async function solveIssue(
    runId: string,
    options: IssueSolverOptions = { ... },
): Promise<IssueSolverReturn> {
    await ensureStatsigInitialized();
    initLogger({ projectName: ISSUE_SOLVER_PROJECT_NAME });
    ...
    const run = await findIssueSolverRunByRunId(runId);   // ← always re-fetches from MongoDB
    const customer = await findCustomerById(run.customerId);
    const solverResult = await runDeepResearch5PhasesAgent(run);
    ...
}
```

Even though the eval harness has the `IssueSolverRunDocument` already in memory (from the dataset), it cannot pass it in — the function signature doesn't allow it. The document's `runId` references a record that exists only in a historical environment's MongoDB, not the current one, so the live DB lookup returns `null`.

### Why Production Is Not Affected

In the production BullMQ worker path, the run record is created by `buildIssueSolverRunForFoamIssue()` → `insertIssueSolverRun(run)` **before** the job is enqueued. Because `issueSolverQueue.add(jobName, { runId })` is only called after the `await insertIssueSolverRun(run)` resolves successfully, the record is guaranteed to be in MongoDB by the time the worker calls `findIssueSolverRunByRunId`. This is purely an eval-path failure.

### Alternative Hypotheses Eliminated

- **Race condition (insert vs. lookup in production):** Ruled out — the write (`insertIssueSolverRun`) strictly precedes the BullMQ enqueue. No window exists for a lookup to race ahead of the insert.
- **Post-creation deletion:** Ruled out — no `deleteOne`, `remove`, or soft-delete path was found for the `IssueSolverRun` collection.
- **Production worker failure:** Ruled out by telemetry — the service name on the failing span is `eval`, not the production worker service.

---

## Fix

Refactor `solveIssue` to accept an optional pre-loaded `IssueSolverRunDocument`. When provided (eval path), skip the DB lookup; when absent (production worker path), fall through to the existing lookup unchanged:

```typescript
export default async function solveIssue(
    runId: string,
    preloadedRun?: IssueSolverRunDocument,   // ← new optional param
    options: IssueSolverOptions = {
        notificationsEnabled: false,
        parseResult: false,
        dbOnlyMode: false,
    },
): Promise<IssueSolverReturn> {
    await ensureStatsigInitialized();
    initLogger({ projectName: ISSUE_SOLVER_PROJECT_NAME });
    ...
    const run = preloadedRun ?? await findIssueSolverRunByRunId(runId);  // ← bypass DB when doc is already available
    const customer = await findCustomerById(run.customerId);
    const solverResult = await runDeepResearch5PhasesAgent(run);
    ...
}
```

The eval harness then calls:

```typescript
solveIssue(input.runId, input, options)
```

**Why this breaks the causal chain:** The root cause is that `solveIssue` forces a DB lookup for a `runId` that doesn't exist in the current environment's MongoDB. By accepting the already-in-memory document, the DB lookup step is skipped entirely when the caller already has the document — the `findOne` that returns `null` is never executed, and the error can no longer be thrown. The production BullMQ worker continues to pass no pre-loaded document, so its behavior is unchanged. This approach is also preferable to seeding the eval DB with historical records, which would be fragile, require teardown, and couple eval execution to live DB write operations.


---
