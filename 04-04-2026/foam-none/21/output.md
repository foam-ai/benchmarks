[Foam Trace ID: 3a3b41aa00ea80946bd060a2adb4e38d] ## TL;DR

A Braintrust trajectory eval task failed because it tried to look up `IssueSolverRun` document by `runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76` from MongoDB and the document doesn't exist. The eval dataset (hosted in Braintrust's platform) contains a stale reference to a run that is no longer present in the MongoDB database the eval service connects to. The `findIssueSolverRunByRunId` function throws a hard error with no graceful fallback for missing documents.

## What Broke and Why

The error originates in a **Braintrust evaluation pipeline** running on GitHub Actions CI. The eval framework iterates over a curated dataset of historical issue solver runs, fetching each one from MongoDB to evaluate it.

**The causal chain:**

1. **Eval dataset contains a stale runId**: The Braintrust hosted dataset for experiment `deep-research-5-phases` (project `nyx-for-trajectory-evals`) contains a datum named `foam-mini-solver-terminal-velocity-failed-after-unavailable-memory` with `input.runId = "3daa8451-d9fa-4b72-b3f5-82e880115e76"`. This runId was valid when it was curated into the dataset but the corresponding MongoDB document no longer exists.

2. **Eval task calls `findIssueSolverRunByRunId`**: The Braintrust framework calls `evaluator.task(datum.input, hooks)` (at `cli.js:11885`), which extracts the runId and calls `findIssueSolverRunByRunId()`:

   ```typescript
   // /repo/mewtwo/src/mongodb/services/issue-solver-run.service.ts
   export async function findIssueSolverRunByRunId(runId: string) {
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

3. **MongoDB query returns null**: The `findOne({ runId })` query executes against MongoDB (logged at `04:44:53.011`: `Finding IssueSolverRun with filter: {"runId":"3daa8451-d9fa-4b72-b3f5-82e880115e76"}`) and returns null after ~1 second (logged at `04:44:54.052`: `Found IssueSolverRun: null`).

4. **Hard error thrown with no fallback**: The null check throws `Error: Issue solver run not found for runId: 3daa8451-...` which propagates to Braintrust's try/catch, marking the eval case as failed.

**Why the document doesn't exist:**

- **Not TTL expiration**: The `IssueSolverRun` Mongoose schema (`/repo/mewtwo/src/mongodb/collections/schemas/issue-solver-run.schema.ts`) has **no TTL indexes or `expires` settings** on any field.
- **Not a race condition**: Documents are created with status `QUEUED` **before** the solver job is even enqueued (`buildIssueSolverRunForFoamIssue()` in `/repo/mewtwo/src/services/foam-issue-solver-trigger.service.ts`), so even crash failures during solving don't prevent document creation.
- **Not programmatic deletion**: No code in the repository deletes `IssueSolverRun` documents.
- **Most likely cause**: The document was either (a) manually deleted from MongoDB, (b) lost during a database migration/restore, or (c) the eval CI environment's `MONGODB_URI` points to a different database instance than where the run was originally created. The eval runs on a GitHub Actions runner using `dotenv`-loaded environment variables — any mismatch between the CI environment's database configuration and the production database where runs are stored would cause this exact failure.

**The architectural gap** is that the Braintrust hosted eval dataset maintains references to MongoDB `runId` values with **no referential integrity mechanism**. The dataset is curated once and persists indefinitely in Braintrust's platform, while the MongoDB documents it references can become unavailable through any number of operational events.

## Fix

**Immediate fix**: Add graceful error handling in the eval task for missing `IssueSolverRun` documents. Instead of letting the hard error propagate, the eval task should catch the "not found" case and return a meaningful result that indicates the eval case is stale, allowing the eval suite to continue running the remaining cases:

```typescript
// In the eval task function
async task(input) {
    try {
        const run = await findIssueSolverRunByRunId(input.runId);
        // ... proceed with evaluation ...
    } catch (error) {
        if (error.message.includes('Issue solver run not found')) {
            return { error: 'run_not_found', runId: input.runId, skipped: true };
        }
        throw error;
    }
}
```

**Root cause fix**: Also clean up the Braintrust eval dataset to remove stale runId references that point to non-existent MongoDB documents. Add a validation step (either in the eval task setup or as a periodic maintenance job) that verifies all runIds in the eval dataset exist in MongoDB before running evaluations:

```typescript
// Pre-eval validation
for (const datum of dataset) {
    const exists = await IssueSolverRun.exists({ runId: datum.input.runId });
    if (!exists) {
        log.warn(`Stale eval case: runId ${datum.input.runId} not found in MongoDB, removing from dataset`);
        // Remove from Braintrust dataset
    }
}
```

**Why this fixes it**: The graceful handling prevents individual stale references from crashing the entire eval suite (breaking the error propagation chain at step 4). The dataset validation prevents stale references from accumulating (breaking the chain at step 1). Additionally, verify that the eval CI environment's `MONGODB_URI` and `DB_NAME` environment variables point to the correct production MongoDB instance where `IssueSolverRun` documents are stored.

---
