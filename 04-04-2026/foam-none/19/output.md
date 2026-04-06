[Foam Trace ID: 7fe92d1c3dc0054d87b08f8b103af354] ## TL;DR

The `git clone --bare` of `foam-ai/mewtwo` failed with "remote: Repository not found" because the GitHub App installation (`98054597`) associated with customer `674e5380f251f603c5ef1847` does not grant access to the `mewtwo` repository. The system generates an installation access token and attempts the clone without first validating that the token has permissions for the target repo, causing the failure to surface as an opaque git error.

## What Broke and Why

The `foam-ai/all-the-things` repository is an evaluation harness that uses the Braintrust eval framework to run AI agent evaluations against target repositories. In this trace, a `SimpletonAgent` eval task was configured to operate on `foam-ai/mewtwo`. When the agent tried to execute its first command (`find /data -name '*.ts' -o -name '*.js' | head -20`), the system needed to clone `mewtwo` into a local bare repo cache.

The clone preparation followed this sequence (from trace `e81c096e74e5dd5ecdf1d6a26a5321a6`):

1. **Repository check**: `ensureRepository` looked for a cached bare repo at `/tmp/tv-base-repos/foam-ai/mewtwo` and found none:
   ```
   Repository not found locally or invalid, cloning {
     repoOwner: 'foam-ai', repoName: 'mewtwo',
     targetPath: '/tmp/tv-base-repos/foam-ai/mewtwo'
   }
   ```

2. **GitHub account lookup**: The system looked up the customer's GitHub integration by `customerId`, not by target repository:
   ```
   Looking up GitHub account {
     customerId: new ObjectId('674e5380f251f603c5ef1847'),
     repoOwner: 'foam-ai', repoName: 'mewtwo'
   }
   ```
   This returned `installationId: '98054597'` — the customer's single GitHub App installation.

3. **Token generation**: An installation access token (`ghs_7vTMhrXEOgs4gAfR1NwtmzARKmLk5z2UQ48m`) was generated from installation `98054597`. **No repository-scoped token was requested**, and **no pre-clone API call verified the installation has access to `mewtwo`**.

4. **Clone failure**: The bare clone was attempted and failed after ~145ms:
   ```
   Command failed: git clone --bare "https://x-access-token:ghs_...@github.com/foam-ai/mewtwo.git" "/tmp/tv-base-repos/foam-ai/mewtwo"
   remote: Repository not found
   ```

**The root cause is that GitHub App installation `98054597` does not have `foam-ai/mewtwo` in its permitted repository list.** GitHub Apps installed on an organization with "selected repositories" mode only generate tokens that can access those selected repos. The installation likely has access to `foam-ai/all-the-things` (the eval harness) but not to `foam-ai/mewtwo` (the eval target).

**The contributing code gap** is that the `ensureRepository` → clone pipeline trusts that any customer with a GitHub integration (`found: true`) can access any repository specified in an eval task. The pipeline has no validation step between token generation and clone execution to verify repository access. The raw `child_process.execSync` error propagates directly with no application-level catch or user-friendly error message — all 7 frames in the stack trace are Node.js internal frames with zero application frames (`in_app: true` count = 0).

**Alternative hypothesis considered**: The repository `foam-ai/mewtwo` might not exist at all. GitHub returns the same "Repository not found" message for both non-existent and permission-denied repos. However, since this is a configured eval task for a known customer with an active GitHub integration, and the organization `foam-ai` clearly exists, the more likely explanation is a permissions gap rather than a nonexistent repository. Either way, the fix is the same: the installation must have access to the target repo, and the code should validate this before attempting the clone.

## Fix

**Immediate fix (configuration):** Add `foam-ai/mewtwo` to the list of accessible repositories for GitHub App installation `98054597`. This is done in the GitHub organization settings under the GitHub App's installation configuration → "Repository access" → add `mewtwo` to the selected repositories.

**Code fix (prevent recurrence for other repos):** Add a pre-clone validation step in the `ensureRepository` flow that verifies the installation token has access to the target repository before attempting the clone. Specifically:

1. After generating the installation access token, call `GET /repos/{owner}/{repo}` (or `GET /installation/repositories` to check the accessible repo list) with the token.
2. If the repo is not accessible, throw a descriptive error: *"GitHub App installation {installationId} does not have access to {owner}/{repo}. Add this repository to the GitHub App's selected repositories in your organization settings."*
3. Optionally, request a repository-scoped installation token by passing `repositories: [repoName]` in the `POST /app/installations/{installation_id}/access_tokens` call — this will fail fast at token creation time with a clear GitHub API error if the repo is not in the installation's scope.

This fix breaks the causal chain at step 3: instead of generating a token and blindly attempting a clone that fails with an opaque "Repository not found" error, the system would detect the permission gap immediately and surface an actionable error message that guides the user to fix their GitHub App configuration.

---
