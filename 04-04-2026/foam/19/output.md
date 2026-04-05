## TL;DR

The `git clone` of `foam-ai/mewtwo` fails with "Repository not found" because `mewtwo` was migrated into the `foam-ai/all-the-things` monorepo but the `/foam-issue/trigger` API endpoint still defaults `repoName` to `'mewtwo'` (a standalone repo that no longer exists). The eval dataset replays a run document created with this stale default, causing the agent's terminal provisioning to attempt cloning a non-existent repository.

## What Broke and Why

The `mewtwo` service code lives as a subdirectory within the `foam-ai/all-the-things` monorepo (confirmed by the workspace path `/home/runner/work/all-the-things/all-the-things/mewtwo/`). However, the `/foam-issue/trigger` API endpoint in `mewtwo/src/routers/issue-solver.ts` has a hardcoded fallback:

```typescript
// TODO(pcga11): Use customer ID and service ID to find repo (like exception-polling.worker.ts does)
const repoOwner = body.repoOwner || 'foam-ai';
const repoName = body.repoName || 'mewtwo';
```

This default was correct when `mewtwo` was a standalone GitHub repository but became stale after the monorepo migration. The TODO comment explicitly acknowledges this should use the proper app→repository lookup (as `exception-polling.worker.ts` already does via `findAppByCustomerIdAndName()`).

When the eval run document for `foam-elastic-parsing-log-error` (runId `c142abac-e028-4911-b730-dc21747b73ef`) was created through this trigger, it stored `metadata.repoOwner: 'foam-ai'` and `metadata.repoName: 'mewtwo'` in MongoDB. The Braintrust eval framework replays this exact document — it calls `findIssueSolverRunByRunId(runId)` and passes the stored metadata directly to the agent.

When the agent invokes `executeCommands`, the terminal provisioning logic in `execute-commands.tool.ts` reads `run.metadata.repoOwner` and `run.metadata.repoName`, passing them to `GitWorktreeService.createWorktree()` → `ensureRepository()` → `setupRepository()` → `gitClone()`, which constructs:

```
git clone --bare "https://x-access-token:{token}@github.com/foam-ai/mewtwo.git" "/tmp/tv-base-repos/foam-ai/mewtwo"
```

Since `foam-ai/mewtwo` no longer exists as a standalone GitHub repository, the clone fails:

```
remote: Repository not found.
fatal: repository 'https://github.com/foam-ai/mewtwo.git/' not found
```

This was attempted twice with two different freshly-generated installation tokens (both valid — authentication succeeded, but the repository itself doesn't exist), confirming the issue is not a token permissions problem but a non-existent target repo.

The error is handled gracefully (`"handled": true`) — the agent continued without a working terminal and completed the investigation using `queryOtel` and `webSearch` tools, but its `executeCommands` and `executeGrep` capabilities were completely non-functional throughout the run.

## Fix

**Primary fix:** Implement the acknowledged TODO in `mewtwo/src/routers/issue-solver.ts` — replace the hardcoded `repoName || 'mewtwo'` default with the proper app→repository lookup, matching the pattern already used in `exception-polling.worker.ts`:

```typescript
const app = await findAppByCustomerIdAndName(customerId, serviceId);
const repo = app.repositories[0];
const { repoOwner, repoName } = repo;
```

This breaks the causal chain at the point where the run document is created: new run documents will store the correct monorepo coordinates (`foam-ai/all-the-things`) instead of the non-existent standalone repo name.

**Secondary fix:** Update the eval dataset — either update the existing MongoDB run document for `c142abac-e028-4911-b730-dc21747b73ef` to have `metadata.repoName: 'all-the-things'`, or create a new run document with correct repo coordinates and update `foam-elastic-parsing-log-error.eval.ts` to reference it. This ensures existing eval replays also use the correct repository.

---