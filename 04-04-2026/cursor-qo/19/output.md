## TL;DR
The issue-solver API router hardcodes `repoName: 'mewtwo'` as the default repository, but `mewtwo` is a directory inside the `foam-ai/all-the-things` mono-repo — not a standalone GitHub repository — causing `git clone` to fail with "Repository not found."

## What Broke and Why

**Causality chain:**

1. The eval service triggered an issue-solver run via the `POST /issue-solver/foam-issue/trigger` API endpoint without specifying `repoOwner` or `repoName` in the request body.

2. In `mewtwo/src/routers/issue-solver.ts` (lines 83–84), the router applies hardcoded defaults:
   ```typescript
   const repoOwner = body.repoOwner || 'foam-ai';
   const repoName = body.repoName || 'mewtwo';
   ```
   There is even a TODO on line 81 acknowledging this is wrong:
   ```
   // TODO(pcga11): Use customer ID and service ID to find repo (like exception-polling.worker.ts does)
   ```

3. These incorrect defaults (`foam-ai/mewtwo`) get stored in the `IssueSolverRun.metadata.repoOwner` and `metadata.repoName` fields of the run document in MongoDB.

4. When the SimpletonAgent's `executeCommands` tool initializes a terminal, it calls `createSessionWorktree()` (in `execute-commands.tool.ts`, lines 91–114), which reads `run.metadata.repoOwner` (`foam-ai`) and `run.metadata.repoName` (`mewtwo`) and passes them to `GitWorktreeService.createWorktree()`.

5. `createWorktree()` → `ensureRepository()` → `setupRepository()` → `gitClone()` generates a GitHub App installation token (installation ID `98054597`) and attempts:
   ```
   git clone --bare "https://x-access-token:<token>@github.com/foam-ai/mewtwo.git" "/tmp/tv-base-repos/foam-ai/mewtwo"
   ```

6. GitHub responds with **"Repository not found"** because `foam-ai/mewtwo` does not exist as a standalone GitHub repository. The actual code lives at `foam-ai/all-the-things` (a mono-repo), with `mewtwo` being just a subdirectory within it.

**Why the production path works correctly:** The exception-polling worker (`exception-polling.worker.ts`, lines 140–153) correctly looks up the repository from the App document:
```typescript
const app = await findAppByCustomerIdAndName(customerId, serviceId);
const repo: RepositoryDocument = app.repositories[0];
const { repoOwner, repoName } = repo;
```
This returns the actual GitHub repository name (e.g., `all-the-things`), not the service/directory name (`mewtwo`).

## Fix

**Immediate fix:** In `mewtwo/src/routers/issue-solver.ts`, replace the hardcoded defaults with a proper repository lookup from the App document, matching the pattern in `exception-polling.worker.ts`:

```typescript
import { findAppByCustomerIdAndName } from '../mongodb/services/app.service';

// Replace lines 81-84 with:
let repoOwner = body.repoOwner;
let repoName = body.repoName;

if (!repoOwner || !repoName) {
    const app = await findAppByCustomerIdAndName(foamIssue.customerId, foamIssue.serviceId);
    if (!app || app.repositories.length === 0) {
        res.status(400).json({
            success: false,
            error: `No repository configured for customer ${foamIssue.customerId} service ${foamIssue.serviceId}`,
        });
        return;
    }
    const repo = app.repositories[0];
    repoOwner = repoOwner || repo.repoOwner;
    repoName = repoName || repo.repoName;
}
```

This resolves the TODO comment and ensures the correct repository (`foam-ai/all-the-things`) is used instead of the non-existent `foam-ai/mewtwo`.

---

## Metrics

**Performance:**
- Total latency: ~120 seconds
- Token usage: ~50000 input tokens + ~5000 output tokens = ~55000 total tokens
- **Model used: opus-4.6** ← REQUIRED - DO NOT CHANGE

**Tool Usage:**
- Top 3 most-used tools: Read, Grep, Shell (query-otel)
- Top 3 most USEFUL tools: Shell/query-otel (input: otel_logs for trace e81c096e74e5dd5ecdf1d6a26a5321a6 — revealed the full timeline showing `foam-ai/mewtwo` clone attempt and "Repository not found" error), Read (input: mewtwo/src/routers/issue-solver.ts — found the hardcoded `'mewtwo'` default on line 84 with the TODO comment), Grep (input: `repoOwner|repoName` across workers and routers — found the correct pattern in exception-polling.worker.ts that dynamically looks up the repo from the App document)
