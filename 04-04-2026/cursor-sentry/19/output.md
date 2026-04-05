## TL;DR
`ensureShaExists` fails because `git fetch --all --prune` cannot retrieve commits that are no longer reachable from any branch or tag (e.g., after squash-merge + branch deletion or force-push), and there is no fallback to fetch the specific SHA directly.

## What Broke and Why

The error `Command failed: git cat-file -e "<sha>"` occurs in `GitWorktreeService.ensureShaExists()` at line 486 of `mewtwo/src/services/git-worktree.service.ts`.

**The causality chain:**

1. An `IssueSolverRun` is created with a `sha` field pointing to a specific commit in a customer's repository (e.g., `foam-ai/all-the-things`).

2. The `executeCommands` tool calls `GitWorktreeService.createWorktree()`, which first calls `ensureRepository()` (clones the repo if missing, or runs `git fetch --all --prune` if it exists), and then calls `ensureShaExists()` to verify the target SHA is available locally.

3. Inside `ensureShaExists()`, the first check (`git cat-file -e "${gitSha}" 2>/dev/null || echo "missing"`) determines the SHA is missing. The method then calls `fetchWithLocking()`, which runs `gitFetch()` — this sets the remote URL and executes `git fetch --all --prune`.

4. **The bug**: `git fetch --all --prune` only fetches objects reachable from refs (branches and tags) that currently exist on the remote. It does **not** fetch commits that are no longer reachable from any ref. This happens commonly when:
   - A PR is **squash-merged** (the original branch commits become unreachable from the merge commit)
   - The source branch is then **deleted** on GitHub
   - A branch is **force-pushed**, replacing old commits with new ones
   - The `--prune` flag further removes local refs for deleted remote branches, ensuring these old commits cannot be reached locally either

5. After the fetch, the second `git cat-file -e "${gitSha}"` (line 486) — this time **without** the `|| echo "missing"` fallback — throws a hard error because the SHA still doesn't exist in the bare repo. This error propagates up through `createWorktree`, is captured in Sentry with the extra data (`repoOwner`, `repoName`, `gitSha`, `customerId`), and then re-thrown.

6. With 3,663 occurrences, this is a systematic issue affecting any run whose target SHA is from a squash-merged or force-pushed branch — a very common workflow pattern.

**Why GitHub retains the commits but `git fetch --all` doesn't get them:**
GitHub keeps commit objects in its storage indefinitely (or for a very long period) after branch deletion. These commits are accessible via GitHub's API (`repos.getCommit`) and via direct SHA fetch (`git fetch origin <sha>`), but they are **not** included in `git fetch --all` output because they're not reachable from any advertised ref.

## Fix

In `mewtwo/src/services/git-worktree.service.ts`, modify `ensureShaExists` to add a fallback that fetches the specific SHA directly when the full fetch doesn't produce it:

```typescript
private async ensureShaExists(
    repoPath: string,
    gitSha: string,
    repoOwner: string,
    repoName: string,
    customerId: mongoose.Types.ObjectId,
): Promise<void> {
    const checkResult = await execAsync(
        `git cat-file -e "${gitSha}" 2>/dev/null || echo "missing"`,
        {
            cwd: repoPath,
        },
    );

    if (checkResult.stdout.trim() === 'missing') {
        log().info('SHA not found, fetching latest changes', { gitSha });
        await this.fetchWithLocking(repoPath, repoOwner, repoName, customerId);

        // Re-check after full fetch before attempting direct SHA fetch
        const recheckResult = await execAsync(
            `git cat-file -e "${gitSha}" 2>/dev/null || echo "missing"`,
            { cwd: repoPath },
        );

        if (recheckResult.stdout.trim() === 'missing') {
            // SHA is not reachable from any ref (e.g., squash-merged PR, force-push, deleted branch).
            // GitHub retains these commits — fetch the specific SHA directly.
            log().info('SHA still missing after ref fetch, attempting direct SHA fetch', { gitSha });
            await this.fetchSpecificSha(repoPath, repoOwner, repoName, customerId, gitSha);
        }

        await execAsync(`git cat-file -e "${gitSha}"`, { cwd: repoPath });
        log().info('SHA found after fetch', { gitSha });
    } else {
        log().debug('SHA exists in repository', { gitSha });
    }
}

private async fetchSpecificSha(
    repoPath: string,
    repoOwner: string,
    repoName: string,
    customerId: mongoose.Types.ObjectId,
    gitSha: string,
): Promise<void> {
    const fetchLockName = `fetch-${repoOwner}-${repoName}`;
    const fetchLockPath = await this.acquireFileLock(fetchLockName);

    try {
        const githubClient = await GitHubApiClient.createFromCustomerId(
            customerId,
            repoOwner,
            repoName,
        );
        const token = await githubClient.getInstallationToken();
        const fetchUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
        await execAsync(`git fetch "${fetchUrl}" "${gitSha}"`, {
            cwd: repoPath,
            timeout: 60000,
        });
        log().info('Successfully fetched specific SHA directly', { gitSha });
    } finally {
        await this.releaseFileLock(fetchLockPath);
    }
}
```

This fix:
- Adds a soft re-check after the full fetch (using the `|| echo "missing"` pattern) to avoid the unnecessary direct fetch when the SHA is already available
- Falls back to `git fetch <url> <sha>` which directly requests the specific commit object from GitHub, bypassing the ref-based discovery mechanism
- Uses the same file-locking pattern as `fetchWithLocking` to prevent concurrent remote URL mutations
- Preserves the final hard assertion (`git cat-file -e` without fallback) so genuinely invalid SHAs still fail fast

---
