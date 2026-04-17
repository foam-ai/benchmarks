[Foam Trace ID: 3f0bc6758d92dee5b8a62214699e74b9] ## TL;DR

An AI agent (`SimpletonAgent`) invoked the `executeCommands` tool targeting the `foam-ai/mewtwo` repository. The system attempted a `git clone --bare` using a GitHub App installation token for `installationId: 98054597`, which failed with `remote: Repository not found.` (HTTP 404, git exit code 128) because that installation has no access to `foam-ai/mewtwo`. The target repo arrived in the run document either from the eval dataset or from the API's hardcoded fallback defaults (`repoOwner || 'foam-ai'` / `repoName || 'mewtwo'`), and no pre-clone access validation exists to catch this before the clone is attempted.

---

## What Broke and Why

### Full Causal Chain

**1. Run document created with `foam-ai/mewtwo` as the target repo**

The failing trace (`isEval: true`) was executed by the Braintrust CLI eval runner. The `IssueSolverRun` MongoDB document was populated with:
```
metadata.repoOwner = 'foam-ai'
metadata.repoName  = 'mewtwo'
```
This value originates from one of two paths. For the automated polling path (`exception-polling.worker.ts`), the repo comes from the customer's registered app config in the DB. For the manual API path (`/routers/issue-solver.ts`), there are hardcoded fallback defaults:
```typescript
const repoOwner = body.repoOwner || 'foam-ai';  // hardcoded default
const repoName  = body.repoName  || 'mewtwo';   // hardcoded default
```
If the API caller omits `repoOwner`/`repoName`, the system silently targets `foam-ai/mewtwo` with no warning. Given `isEval: true`, the eval dataset or the API call that created the run omitted these fields, causing the fallback to `foam-ai/mewtwo`.

**2. Agent invokes `executeCommands`, triggering a workspace setup**

`SimpletonAgent` called `executeCommands` with:
```json
{"commands": [{"keystrokes": "find /data -name '*.ts' -o -name '*.js' | head -20\n", "duration": 1}]}
```
`execute-commands.tool.ts` reads the repo identity from the run document:
```typescript
repoOwner = run.metadata.repoOwner;  // → 'foam-ai'
repoName  = run.metadata.repoName;   // → 'mewtwo'
```
And calls `GitWorktreeService.ensureRepository('foam-ai', 'mewtwo', customerId)`.

**3. No local bare clone exists → `gitClone()` is invoked**

The service checks for a cached clone at `/tmp/tv-base-repos/foam-ai/mewtwo`, finds none (log: `"Repository not found locally or invalid"` at `19:36:18.085`), and proceeds to `gitClone()`.

**4. Token obtained successfully — but doesn't guarantee repo access**

`GitHubApiClient.createFromCustomerId(customerId, 'foam-ai', 'mewtwo')` looks up `installationId: 98054597` in the DB for customer `674e5380f251f603c5ef1847` and successfully exchanges it for a short-lived `ghs_` token:
```typescript
const token = await githubClient.getInstallationToken();
// → ghs_7vTMhrXEOgs4gAfR1NwtmzARKmLk5z2UQ48m
```
Critically, `getInstallationToken()` only confirms the App credentials are valid — it does **not** validate that the installation has access to any specific repository. There is zero pre-clone check (no call to e.g. `GET /installation/repositories`).

**5. `git clone --bare` fails with HTTP 404**

```bash
git clone --bare "https://x-access-token:ghs_7vT...@github.com/foam-ai/mewtwo.git" \
    "/tmp/tv-base-repos/foam-ai/mewtwo"
# Cloning into bare repository '/tmp/tv-base-repos/foam-ai/mewtwo'...
# remote: Repository not found.
# fatal: repository 'https://github.com/foam-ai/mewtwo.git/' not found
# exit code: 128
```

GitHub App installation `98054597` does not have access to `foam-ai/mewtwo` (either the repo is inaccessible to this installation, or it does not exist under that name for this customer context). The clone fails in ~145ms — consistent with a fast remote 404 rejection.

**6. Error propagates up, `executeCommands` returns failure**

The clone exception is caught and returned as the tool result:
```json
{"success": false, "error": "Command failed: git clone --bare ... remote: Repository not found.\nfatal: repository 'https://github.com/foam-ai/mewtwo.git/' not found\n"}
```
The parent `ai.toolCall` span captures `success: false` but is not marked as an OTel error at the span level. The exception is recorded in two sibling child spans (duplicate error instrumentation, not a retry).

### Why This Is Both a Configuration Issue and a Code Defect

- **Configuration**: The GitHub App installation (`98054597`) used in this eval does not have access to `foam-ai/mewtwo`. The eval should have been configured to target a repository accessible to that installation.
- **Code defect**: The hardcoded fallback `repoName || 'mewtwo'` in `issue-solver.ts` silently routes misconfigured or underspecified API calls to an internal development repo. Additionally, no pre-clone validation exists — the first access check is the `git clone` itself.

### Alternative Hypothesis Considered and Eliminated

**Auth failure (401/403)**: A 401 would produce `remote: Invalid username or password.` and a 403 would produce a different preamble. The `remote: Repositor...` prefix uniquely matches `remote: Repository not found.` (GitHub's 404 message). Furthermore, the token was successfully obtained (the `ghs_` token appears in the clone URL), and the ~145ms failure duration is consistent with a fast 404 rejection, not an auth negotiation timeout. **Eliminated.**

---

## Fix

### Immediate Fix — Remove the hardcoded fallback defaults

In `/repo/mewtwo/src/routers/issue-solver.ts`, replace the silent fallback:
```typescript
// BEFORE (broken — silently defaults to an inaccessible internal repo)
const repoOwner = body.repoOwner || 'foam-ai';
const repoName  = body.repoName  || 'mewtwo';
```
```typescript
// AFTER — require explicit values, fail fast with a clear error
const { repoOwner, repoName } = body;
if (!repoOwner || !repoName) {
    throw new BadRequestError('repoOwner and repoName are required fields');
}
```

**Why this breaks the causal chain:** Without the silent fallback, API calls or eval datasets that omit `repoOwner`/`repoName` will fail immediately with a descriptive validation error instead of silently proceeding to clone an inaccessible/nonexistent repo. The `foam-ai/mewtwo` 404 clone path becomes impossible to reach through this code path.

### Secondary Fix — Add pre-clone repository access validation

In `GitWorktreeService.gitClone()`, add a GitHub API check before the clone:
```typescript
// After getting the token, verify the repo is accessible:
await githubClient.octokit.rest.repos.get({ owner: repoOwner, repo: repoName });
// Throws HttpError 404 with a clear message before the clone is attempted
```

This provides an explicit, actionable error (`Repository not found or inaccessible`) at the right abstraction level rather than surfacing a raw git command failure.

### For the Eval Configuration

The eval dataset or the API call that triggered this eval must be updated to supply a valid `repoOwner`/`repoName` that the GitHub App installation (`installationId: 98054597`) actually has access to. This is an operational fix required alongside the code change.


---
