## TL;DR
Eval worker job timed out after 2 hours because `yarn eval run --sha` was submitted without `--local`, causing recursive queue submission; the nested local job then crashed on `git status` since the Docker container has no `.git` directory, and the parent's `waitUntilFinished` hung indefinitely rather than detecting the child job's failure.

## What Broke and Why

**The failure chain has three layers:**

### 1. Missing `--local` flag causes recursive queue submission
An eval job was submitted to the `eval-queue` with command:
```
yarn eval run --sha 80a148e0... --sha fea37535... --sha a12dc06b...
```
Without the `--local` flag, the `shouldRunRemote` logic in `mewtwo/src/bin/eval.ts:185` defaults to `true`:
```typescript
const shouldRunRemote = !options.local && options.remote !== false;
// !undefined && undefined !== false → true && true → true
```
So the command, **already running on a TV worker**, re-submitted itself to the **same eval-queue** as Job #7 with `--local` appended. This is a wasteful recursive pattern — the worker spawns a process that creates another job on the same queue it's processing.

### 2. Docker container has no `.git` directory → `git status` crashes
Job #7 ran `yarn eval run --local --sha ...` which triggers the `--sha` code path at `eval.ts:279-294`. This calls `isWorkingDirectoryClean()` from `eval/utils/git-operations.ts:21`, which executes `git status --porcelain`. The `Dockerfile.tv-worker` copies source files (`COPY mewtwo/ ./mewtwo/`) but does **not** include the `.git` directory, so git fails:
```
fatal: not a git repository (or any of the parent directories): .git
Error: Failed to check git status: Error: Command failed: git status --porcelain
```
Job #7 failed twice (queue configured with `attempts: 2` in `eval.queue.ts:12`) at timestamps `02:56:18` and `02:56:26`.

### 3. `waitUntilFinished` hangs → 2-hour timeout
Job #2's subprocess was blocked on `job.waitUntilFinished(queueEvents)` (eval.ts:246), waiting for Job #7 to complete. Despite Job #7 failing after both retry attempts, `waitUntilFinished` never resolved/rejected — likely a BullMQ QueueEvents race condition or connection issue in the containerized environment. With no fallback timeout on the `waitUntilFinished` call, the process sat idle until the worker's 7200000ms (2-hour) `setTimeout` at `eval.worker.ts:97-101` fired:
```
Error: Command timed out after 7200000ms
    at Timeout._onTimeout (/app/mewtwo/src/workers/eval.worker.ts:100:36)
```

**Timeline:**
| Time | Event |
|------|-------|
| 02:56:07 | Job #2 starts, spawns `yarn eval run --sha ...` |
| 02:56:14 | Subprocess defaults to remote, submits Job #7 with `--local` |
| 02:56:18 | Job #7 attempt 1 fails: `fatal: not a git repository` |
| 02:56:26 | Job #7 attempt 2 fails: same git error |
| 02:56:28 | Job #7 permanently failed |
| 02:56:28–04:56:07 | **2-hour gap**: Job #2 subprocess hangs on `waitUntilFinished` |
| 04:56:07 | Worker timeout fires, kills child, marks Job #2 as failed |

## Fix

### Fix 1: Default to local when running in production/Docker (prevents recursive submission)
In `mewtwo/src/bin/eval.ts`, detect the production environment and force local execution:

```typescript
// Line 185 - replace:
const shouldRunRemote = !options.local && options.remote !== false;

// With:
const isProductionWorker = process.env.ENVIRONMENT === 'production' || !!process.env.ECS_CONTAINER_METADATA_URI;
const shouldRunRemote = !options.local && options.remote !== false && !isProductionWorker;
```

### Fix 2: Fail fast when `.git` is missing (prevents silent hang)
In `mewtwo/src/bin/eval.ts`, add a git repo check before attempting git operations:

```typescript
// Before line 287 ("Running pre-flight checks...")
const { execSync } = require('child_process');
try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
} catch {
    console.error('\n❌ Error: Not a git repository. The --sha flag requires a git repo.');
    console.error('   When running on TV workers, the Docker image does not include .git.');
    console.error('   Use the GitHub Actions workflow to run SHA-based evals instead.\n');
    process.exit(1);
}
```

### Fix 3: Add timeout to `waitUntilFinished` (prevents indefinite hang)
In `mewtwo/src/bin/eval.ts`, add a timeout to the wait call:

```typescript
// Line 246 - replace:
await job.waitUntilFinished(queueEvents);

// With:
const jobTimeout = parseInt(options.timeout) + 60000; // job timeout + 1min buffer
await job.waitUntilFinished(queueEvents, jobTimeout);
```

---
