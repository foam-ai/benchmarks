## TL;DR

A Braintrust trajectory eval failed because commit `2b804f0` introduced a hardcoded `runId` (`3daa8451-d9fa-4b72-b3f5-82e880115e76`) in `mewtwo/evals/rca-evals.ts` for the `foam-mini-solver-terminal-velocity-failed-after-unavailable-memory` eval case that does not exist in the MongoDB database the eval worker connects to. The eval task unconditionally calls `findIssueSolverRunByRunId(runId)`, which throws immediately when MongoDB returns `null`. The fix is to replace the stale/invalid `runId` with one that exists in the target MongoDB environment.

---

## What Broke and Why

### The Trajectory Eval System

The `mewtwo` service includes a "trajectory eval" system that re-runs past, real `IssueSolverRun` records through the current agent version to benchmark RCA quality. The eval test cases are defined as a **static TypeScript array** of `{name, runId}` pairs in `mewtwo/evals/rca-evals.ts`:

```typescript
export const evals: EvalCase[] = [
    // ...
    {
        name: 'foam-mini-solver-terminal-velocity-failed-after-unavailable-memory',
        runId: '3daa8451-d9fa-4b72-b3f5-82e880115e76',  // ← introduced in commit 2b804f0
    },
    // ...
];
```

Each `runId` is a UUID pointing to a real `IssueSolverRunDocument` in MongoDB. These documents are created by the production trigger path (`triggerSolverForFoamIssue` → `insertIssueSolverRun` → `issueSolverQueue.add`), but there is **no guarantee** that the specific UUID hardcoded in the eval file exists in the database the eval process connects to.

### The Failing Code Path

The eval harness (`mewtwo/evals/index.eval.ts`) passes the hardcoded `runId` directly to the eval task, which calls `findIssueSolverRunByRunId`:

```typescript
// mewtwo/src/mongodb/services/issue-solver-run.service.ts
export async function findIssueSolverRunByRunId(runId: string): Promise<IssueSolverRunDocument> {
    const connection = await connectToDatabase();
    return await connection.withSession(async (session) => {
        const issueSolverRunColl = new IssueSolverRunCollection(session);
        const runDocument = await issueSolverRunColl.findIssueSolverRun({ runId });
        if (!runDocument) {
            throw new Error(`Issue solver run not found for runId: ${runId}`);  // ← crash site
        }
        return runDocument;
    });
}
```

There is **no pre-validation**, no retry, and no preflight check anywhere in the eval pipeline to confirm that all `runId` values in `rca-evals.ts` resolve to existing MongoDB documents before execution begins.

### The Specific Failure

Telemetry from `traceId=f6ab8ba909de0a1e31fd099d55c93cdb` shows the exact sequence:

1. `2026-03-17 04:44:53.011` — Log: `Finding IssueSolverRun with filter: {"runId":"3daa8451-d9fa-4b72-b3f5-82e880115e76"}`
2. `2026-03-17 04:44:54.052` — Log: `Found IssueSolverRun: null` — MongoDB returned no matching document (~1 second clean query, no timeout or DB error)
3. `2026-03-17 04:44:54.052` — Error thrown: `Issue solver run not found for runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76` → eval task marked failed

The `runId` `3daa8451-d9fa-4b72-b3f5-82e880115e76` was introduced in commit `2b804f0` ("Tweak scorer prompt") — a change to the `foam-mini-solver-terminal-velocity-failed-after-unavailable-memory` eval case. The prior version of this entry (from commit `c3c83f5`) used a different `runId` (`70d2fbc1-f68f-4bad-934d-334831c4dcf4`). The newly introduced `runId` either references a run that: (a) was created in a different MongoDB environment (dev/staging) and never promoted to the production instance, (b) was never successfully persisted at all, or (c) was incorrectly transcribed.

**No deletion or expiry explains the missing document:** A full audit of the `IssueSolverRunSchema`, `IssueSolverRunCollection`, and `issue-solver-run.service.ts` confirms zero TTL indexes, zero `deleteOne`/`deleteMany` calls, and zero cleanup operations — documents are never automatically removed. The document simply was never present in the database being queried.

---

## Fix

**Immediate fix:** Replace the invalid `runId` in `mewtwo/evals/rca-evals.ts` for the `foam-mini-solver-terminal-velocity-failed-after-unavailable-memory` case with a valid `runId` that exists in the MongoDB instance the eval worker connects to:

```typescript
// Before (broken — runId does not exist in MongoDB):
{
    name: 'foam-mini-solver-terminal-velocity-failed-after-unavailable-memory',
    runId: '3daa8451-d9fa-4b72-b3f5-82e880115e76',
}

// After (fixed — use a runId that is confirmed to exist in the target MongoDB):
{
    name: 'foam-mini-solver-terminal-velocity-failed-after-unavailable-memory',
    runId: '<valid-runId-from-target-mongodb>',
}
```

This fix breaks the causal chain at the root: with a valid `runId`, `findIssueSolverRunByRunId` returns the document instead of `null`, and the error is never thrown.

**Structural fix (prevents recurrence):** Add a preflight validation step to the eval runner that checks all `runId` values in `rca-evals.ts` against MongoDB before starting any Braintrust eval tasks. For example, in `mewtwo/evals/index.eval.ts`, before the `Eval()` loop:

```typescript
// Preflight: validate all runIds exist in MongoDB
for (const { name, runId } of evalsToRun) {
    const exists = await fastFindIssueSolverRun({ runId });
    if (!exists) {
        throw new Error(`Eval dataset integrity check failed: runId ${runId} (case: ${name}) does not exist in MongoDB. Update rca-evals.ts with a valid runId.`);
    }
}
```

This makes any future stale/invalid `runId` fail fast with a clear error at startup rather than manifesting as a mid-run task failure in Braintrust, and it enforces that eval datasets always reference real, accessible documents.

---