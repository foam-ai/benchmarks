## TL;DR
The `gitClone` method in `git-worktree.service.ts` embeds the GitHub App installation token directly in the `git clone` URL; when the clone fails (here, because the installation lacks access to `foam-ai/mewtwo`), `execAsync` throws an error containing the full command—**leaking the short-lived credential into Sentry/telemetry**—and provides no actionable diagnosis of the access failure.

## What Broke and Why

The failure chain is:

1. **The eval service creates an `IssueSolverRun`** whose `metadata.repoOwner`/`metadata.repoName` point to `foam-ai/mewtwo`, and whose `customerId` maps to a specific GitHub App installation.

2. **`GitWorktreeService.ensureRepository()`** is called (via `createWorktree()` → `ensureRepository()`) to clone the repository into `/tmp/tv-base-repos/foam-ai/mewtwo`. Since the directory doesn't exist yet, it calls `setupRepository()` → `gitClone()`.

3. **`gitClone()` (line 146–175 of `git-worktree.service.ts`)** looks up the customer's GitHub App installation via `GitHubApiClient.createFromCustomerId(customerId, repoOwner, repoName)`, retrieves an installation token (`ghs_...`), and constructs a clone URL with the token embedded inline:
   ```
   https://x-access-token:<token>@github.com/foam-ai/mewtwo.git
   ```

4. **The `git clone --bare` command fails** because the GitHub App installation associated with this `customerId` does not have repository access to `foam-ai/mewtwo`. GitHub returns `"remote: Repository not found."` (the truncated `"remote: Repositor..."` in the telemetry). This happens when the GitHub App is installed with "selected repositories" and `mewtwo` is not among them, or when the `customerId` maps to an installation in a different organization entirely.

5. **`execAsync` (Node's `child_process.exec` promisified) throws an `Error`** whose `.message` includes the full shell command—**including the plaintext access token**. This error propagates unmodified through `setupRepository()` → `ensureRepository()` → `createWorktree()`, gets captured by Sentry and the telemetry pipeline, and the token is persisted in the error log.

The same token-in-URL pattern exists in `gitFetch()` (line 196), where `git remote set-url origin "${cloneUrl}"` also embeds the token in the command string.

## Fix

**Sanitize credentials from error messages and provide a diagnostic error for access failures.** In `gitClone()`, wrap the `execAsync` call in a try-catch that strips the token from the error and detects the "Repository not found" pattern:

```typescript
protected async gitClone({
    repoOwner,
    repoName,
    targetPath,
    customerId,
}: {
    repoOwner: string;
    repoName: string;
    targetPath: string;
    customerId: mongoose.Types.ObjectId;
}): Promise<void> {
    const githubClient = await GitHubApiClient.createFromCustomerId(
        customerId,
        repoOwner,
        repoName,
    );
    const token = await githubClient.getInstallationToken();

    const cloneUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    log().info('Using traditional exec git clone', { repoOwner, repoName, targetPath });

    try {
        await execAsync(`git clone --bare "${cloneUrl}" "${targetPath}"`, {
            timeout: 300000,
        });
    } catch (error) {
        const sanitizedMessage = (error instanceof Error ? error.message : String(error))
            .replace(/x-access-token:[^\s@"]+/g, 'x-access-token:[REDACTED]');

        if (sanitizedMessage.includes('Repository not found')) {
            throw new Error(
                `GitHub App installation for customer ${customerId} does not have access to ${repoOwner}/${repoName}. ` +
                `Verify the GitHub App is installed with access to this repository.`,
            );
        }

        throw new Error(`git clone failed for ${repoOwner}/${repoName}: ${sanitizedMessage}`);
    }

    log().info('Successfully cloned repository', { repoOwner, repoName, targetPath });
}
```

Apply the same sanitization to `gitFetch()` for the `git remote set-url` call:

```typescript
try {
    await execAsync(`git remote set-url origin "${cloneUrl}"`, {
        cwd: repoPath,
        timeout: 30000,
    });
} catch (error) {
    const sanitizedMessage = (error instanceof Error ? error.message : String(error))
        .replace(/x-access-token:[^\s@"]+/g, 'x-access-token:[REDACTED]');
    throw new Error(`git remote set-url failed for ${repoOwner}/${repoName}: ${sanitizedMessage}`);
}
```

This fix addresses both problems: it prevents the token from leaking into error telemetry, and it surfaces a clear, actionable message when the GitHub App installation doesn't have access to the target repository.
