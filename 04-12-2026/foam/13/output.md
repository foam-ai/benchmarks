[Foam Trace ID: 1e8879a8fec93508a6064a8c9921cf83] ## TL;DR

An eval-queue job (`yarn eval run --sha <3 SHAs>`) timed out after exactly 2 hours because the child process it spawned submitted a nested job with `--local` injected (to prevent infinite recursion) and then hung indefinitely in `job.waitUntilFinished(queueEvents)` — with no timeout — waiting for that nested job to complete. The nested job failed immediately on every attempt with `fatal: not a git repository` because the production container has no `.git` directory, yet the `--local --sha` code path unconditionally runs git-dependent pre-flight checks. The fix is twofold: (1) skip or guard the git pre-flight checks in containerized environments, and (2) pass a TTL to `waitUntilFinished` so a missed failure event cannot cause an indefinite hang.

---

## What Broke and Why

### The Causal Chain

**Step 1 — Job submission.** A BullMQ job (Job ID 2) was placed on `eval-queue` with the command `yarn eval run --sha 80a148e --sha fea3753 --sha a12dc06 -m 20`. No `--local` flag was present. The eval worker picked it up and, per `eval.worker.ts`:

```typescript
const { command, timeout = 7200000 } = job.data;
// ...
const child = spawn('/bin/bash', ['-c', command], { cwd: mewtwoPath, env: process.env });
// ...
if (timeout) {
    setTimeout(() => {
        clearInterval(flushTimer);
        child.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
}
```

The child process was spawned with a **2-hour `setTimeout`** as the only safety net. No `clearTimeout` is called if the child exits cleanly — the timer always fires unconditionally.

**Step 2 — Remote re-submission with `--local` injection.** Inside the child, `eval.ts` detected the absence of `--local` and entered remote mode. It built a new command with `--local` injected (by design, to prevent infinite recursive re-submission) and submitted it as Job 7 to the same `eval-queue`:

```typescript
const commandParts = ['yarn eval run', '--local'];
// ... append --sha ..., -m 20
const job = await evalQueue.add('run-eval', { command, timeout: 7200000 });
console.log(`✅ Job 7 submitted`);
console.log(`⏳ Waiting for completion...`);

await job.waitUntilFinished(queueEvents);  // ← NO TTL ARGUMENT
```

The `waitUntilFinished` call uses BullMQ `QueueEvents` (Redis pub/sub). Critically, **no TTL is passed as the second argument**, so if the `failed` or `completed` event is never received, this `await` never settles.

Telemetry confirms this exact output at ~t=7s into the job:
> `🚀 Submitting to production TV queue... ✅ Job 7 submitted ⏳ Waiting for completion...`

**Step 3 — Nested job fails immediately due to missing git.** Job 7 was picked up by another eval worker and ran `yarn eval run --local --sha ... -m 20`. In `eval.ts`, the `--local` + `--sha` code path unconditionally executes pre-flight checks:

```typescript
if (options.sha && options.sha.length > 0) {
    console.log('\n🔍 Running pre-flight checks...');

    if (!isWorkingDirectoryClean()) {
        // Runs: git status --porcelain
        // In container: fatal: not a git repository
        console.error('\n❌ Error: Working directory is not clean');
        process.exit(1);
    }
    // ...
}
```

The production container is built from `Dockerfile.tv-worker`, which copies source files via `COPY mewtwo/ ./mewtwo/` — the `.git` directory lives at the repository root and is never included. `git status --porcelain` fails fatally:

```
fatal: not a git repository (or any of the parent directories): .git
Error: Failed to check git status: Error: Command failed: git status --porcelain
❌ Failed: Command failed with exit code 1
```

This is confirmed by telemetry spans s8 and s10, logged at ~t=11s and ~t=21s.

**Step 4 — BullMQ retries exhaust within ~28 seconds.** The `eval-queue` is configured with `{ attempts: 2, backoff: { type: 'exponential', delay: 5000 } }`. Both attempts for Job 7 failed within ~3.5 seconds each, with retry backoff of ~5 seconds between them. All meaningful child-process output ceased at ~t=28s into the 2-hour job.

**Step 5 — `waitUntilFinished` hangs indefinitely.** After Job 7's final attempt failed, BullMQ should have emitted a terminal `failed` event on the `QueueEvents` pub/sub channel, which would have caused `waitUntilFinished` to reject, the `catch` block to fire, and `process.exit(1)` to terminate the child. This did not happen. The child process went silent and remained alive — its open stdout/stderr pipes preventing `child.on('close')` from ever firing in the parent eval worker. The absence of any `ttl` argument on `waitUntilFinished` meant there was no application-level escape.

**Step 6 — 2-hour timeout fires.** After exactly 7,200,000ms, the `setTimeout` in `eval.worker.ts` fired:

```typescript
setTimeout(() => {
    clearInterval(flushTimer);
    child.kill();
    reject(new Error(`Command timed out after ${timeout}ms`));
}, timeout);  // timeout = 7200000 (default)
```

BullMQ marked Job 2 as failed with `Command timed out after 7200000ms`, confirmed by telemetry:
> `Eval failed { jobId: '2', error: 'Command timed out after 7200000ms' }` — `eval.worker.ts:130`

### Two Compounding Defects

| Defect | Location | Effect |
|---|---|---|
| Git pre-flight checks run unconditionally in container | `eval.ts` pre-flight block, `git-operations.ts` | Every `--local --sha` execution in production fails instantly — the nested job can never succeed |
| `waitUntilFinished` called with no TTL | `eval.ts` remote wait path | A missed or undelivered Redis pub/sub event causes an indefinite hang; the only recovery is the outer 2-hour kill |

The git issue is the **functional root cause** — it makes the nested job permanently unrecoverable. The missing TTL is the **safety-net failure** — it turns a fast failure into a 2-hour hang instead of a quick propagated error.

---

## Fix

### Fix 1 (Root Cause — Functional): Guard git pre-flight checks in containerized environments

The `--local` flag was designed to prevent recursive re-submission, not to signal "running in a developer git checkout." The container correctly omits `.git`. The pre-flight checks should not assume a git repository is present when running in the worker container.

**Option A (recommended):** Add a `--no-git-checks` (or `--container`) flag that `eval.worker.ts` injects alongside `--local`, and gate the pre-flight block on its absence:

```typescript
// In eval.worker.ts command construction:
const commandParts = ['yarn eval run', '--local', '--no-git-checks'];

// In eval.ts pre-flight block:
if (options.sha && options.sha.length > 0 && !options.noGitChecks) {
    // run git pre-flight checks only in dev environments
}
```

**Option B:** In `git-operations.ts`, detect the absence of a `.git` directory and return gracefully rather than throwing:

```typescript
export function isWorkingDirectoryClean(): boolean {
    if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
        return true; // No git repo — skip check, assume clean
    }
    // ... existing git status logic
}
```

This fix breaks the causal chain at Step 3: Job 7 would pass pre-flight checks, proceed to run the eval, and complete (or fail for a real reason) — the `waitUntilFinished` call would then settle and the child process would exit normally.

### Fix 2 (Safety Net): Add a TTL to `waitUntilFinished`

Regardless of Fix 1, the `waitUntilFinished` call should never be allowed to hang indefinitely. Pass a TTL that is well under the outer worker timeout (e.g., 30 minutes, leaving margin before the 2-hour kill):

```typescript
const WAIT_TTL_MS = 30 * 60 * 1000; // 30 minutes

try {
    await job.waitUntilFinished(queueEvents, WAIT_TTL_MS);
} catch (error) {
    clearInterval(logPolling);
    console.error('\n❌ Eval failed:', error);
    process.exit(1);
}
```

If the Redis pub/sub `failed` event is ever dropped or delayed, `waitUntilFinished` will now throw after 30 minutes, the child process will exit with code 1, and the outer eval worker will mark the job as failed promptly — rather than hanging for 2 hours.

### Fix 3 (Minor Hygiene): Clear the `setTimeout` on child exit

In `eval.worker.ts`, store the timeout handle and clear it when the child exits to avoid the dangling timer after successful jobs (which keeps the Node.js event loop alive unnecessarily):

```typescript
let timeoutHandle: NodeJS.Timeout | undefined;
if (timeout) {
    timeoutHandle = setTimeout(() => {
        clearInterval(flushTimer);
        child.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
}

child.on('close', (code) => {
    clearInterval(flushTimer);
    if (timeoutHandle) clearTimeout(timeoutHandle); // ← add this
    // ... resolve or reject
});
```


---
