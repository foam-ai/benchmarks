## TL;DR
Eval dataset references a hardcoded `runId` (`3daa8451-d9fa-4b72-b3f5-82e880115e76`) for an `IssueSolverRun` document that no longer exists in MongoDB, causing `findIssueSolverRunByRunId` to throw on every eval execution of the `foam-mini-solver-terminal-velocity-failed-after-unavailable-memory` test case.

## What Broke and Why

**The failure chain:**

1. **Eval dataset with stale reference**: The file `mewtwo/evals/rca-evals.ts` contains a static list of eval cases, each mapping an eval name to an `IssueSolverRun.runId`. The case `foam-mini-solver-terminal-velocity-failed-after-unavailable-memory` maps to `runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76`.

2. **Eval framework looks up the run document**: When `mewtwo/evals/index.eval.ts` executes, it iterates over all eval cases and all configured experiments. For each combination, the `runExperimentTask()` function calls `findIssueSolverRunByRunId(runId)` (line ~98 of `index.eval.ts`) to fetch the `IssueSolverRun` document from MongoDB. This document contains the full telemetry snapshot, customer info, repo metadata, and error context needed by the experiment runner.

3. **Document deleted from MongoDB**: The `IssueSolverRun` document with `runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76` no longer exists in the database. It was likely removed during a data cleanup, TTL expiration, or manual purge after the eval case was added to the dataset.

4. **`findIssueSolverRunByRunId` throws unconditionally**: In `mewtwo/src/mongodb/services/issue-solver-run.service.ts` (line 146), this function throws `Error("Issue solver run not found for runId: ...")` when the document is `null`. Unlike `findCompletedIssueSolverRunByRunId` or `fastFindIssueSolverRunByRunId` which return `null`, this function has a hard throw.

5. **Error multiplied across 4 parallel experiments**: The telemetry shows the same `runId` was processed simultaneously by 4 experiment variants (2x `deep-research-5-phases`, 2x `deep-research-5-phases-skills`), each generating the same error within a ~2-second window (04:44:52–04:44:54 UTC). All 4 are caught by the `try/catch` in `runExperimentTask` and reported to foam/Sentry telemetry via `foam.captureException(error)`.

6. **Error is caught but still noisy**: The eval framework's `try/catch` returns `FAILURE_MESSAGE` so the eval doesn't fully crash, but each failure is reported as an exception to the error monitoring system, creating noise.

**Evidence from telemetry:**

- **Trace `f6ab8ba909de0a1e31fd099d55c93cdb`**: Parent span is `eval.task.nyx-for-trajectory-evals-deep-research-5-phases/foam-mini-solver-terminal-velocity-failed-after-unavailable-memory` with `eval.run_id: 3daa8451-d9fa-4b72-b3f5-82e880115e76`. Child error span has `StatusCode: Error`, duration `0ms` (instant failure on DB lookup).
- **Logs confirm**: `Finding IssueSolverRun with filter: {"runId":"3daa8451-d9fa-4b72-b3f5-82e880115e76"}` immediately followed by the error in all 4 traces.
- **Release**: `ea085e3bdc1cffe3a20b2283a2334392bb7d482c` (commit "ai sdk registry cleanup/update #396"), running on Ubuntu 24.04, AMD EPYC 9V74, 256GB RAM — a CI/eval runner, not a production app server.

## Fix

**Immediate fix — remove or replace the stale eval case:**

In `mewtwo/evals/rca-evals.ts`, either:
- **Remove** the entry if the test case data is irrecoverable:
  ```typescript
  // Remove this line:
  { name: 'foam-mini-solver-terminal-velocity-failed-after-unavailable-memory', runId: '3daa8451-d9fa-4b72-b3f5-82e880115e76' },
  ```
- **Replace** the `runId` with a valid one if the IssueSolverRun can be re-seeded from backup.

**Defensive fix — pre-validate eval data before running:**

Add a validation step in `mewtwo/evals/index.eval.ts` before the eval loop that checks all referenced `runId`s exist in MongoDB. This prevents silent failures and gives an immediate, actionable error at startup:

```typescript
// Add before the eval registration loop
async function validateEvalData(evalCases: EvalCase[]): Promise<void> {
  const { connectToDatabase } = await import('../src/mongodb/db');
  const connection = await connectToDatabase();
  await connection.withSession(async (session) => {
    const IssueSolverRun = (await import('../src/mongodb/collections/documents')).IssueSolverRun;
    const runIds = evalCases.map(e => e.runId);
    const found = await IssueSolverRun.find({ runId: { $in: runIds } })
      .select({ runId: 1 })
      .session(session)
      .lean();
    const foundIds = new Set(found.map(r => r.runId));
    const missing = runIds.filter(id => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Eval data integrity error: ${missing.length} IssueSolverRun documents not found for runIds: ${missing.join(', ')}`);
    }
  });
}
```

**Prevent recurrence — add a CI check for eval data freshness:**

Add a lightweight CI step that validates all `runId`s in `rca-evals.ts` exist in the database before running the eval suite. This catches stale references before they reach production eval runs.

---

## Metrics

**Performance:**
- Total latency: ~120 seconds
- Token usage: ~15000 input tokens + ~4000 output tokens = ~19000 total tokens
- **Model used: opus-4.6** ← REQUIRED - DO NOT CHANGE

**Tool Usage:**
- Top 3 most-used tools: Shell (query-otel), Grep, Read
- Top 3 most USEFUL tools: Shell/query-otel (input: traces for TraceId f6ab8ba909de0a1e31fd099d55c93cdb — revealed the 4 parallel failures and span hierarchy), Shell/query-otel (input: logs containing runId 3daa8451 — showed the "Finding IssueSolverRun" → "not found" sequence across all experiments), Read (input: mewtwo/evals/index.eval.ts via git show — revealed the exact code path: runId from dataset → findIssueSolverRunByRunId → throw)
