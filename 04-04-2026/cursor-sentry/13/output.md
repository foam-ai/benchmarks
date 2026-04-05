## TL;DR
Eval worker command `yarn eval run --sha ...` was submitted to the queue without the `--local` flag, causing the spawned child process to recursively re-submit to the same queue instead of executing locally, leading to a 2-hour timeout.

## What Broke and Why

The eval worker (`eval.worker.ts`) processes jobs from the `eval-queue` by spawning child processes via `bash -c <command>`. The Sentry event (MEWTWO-50) shows the command that was executed:

```
yarn eval run --sha 80a148e05a63ed59d9aee3c2d8675f9b7b9ae8f5 --sha fea37535fba35939fb7ffdf3cba661c3c003e6ac --sha a12dc06bf21444d0b8354b03943a5f24345a4912
```

This command is missing the critical `--local` flag. Here's the causality chain:

1. **Job submitted without `--local`**: The command was placed into the `eval-queue` without the `--local` flag. The CLI code in `eval.ts` (line 193) does add `--local` when building the remote command (`const commandParts = ['yarn eval run', '--local']`), so this job was likely submitted through a different path (direct queue insertion, admin tooling, or an older code version).

2. **Recursive queue submission**: When the eval worker spawned this command, the child process's `shouldRunRemote` logic (`eval.ts` line 185: `!options.local && options.remote !== false`) evaluated to `true` because `--local` was absent. The child process then connected to Redis and submitted a **new** job to the same `eval-queue` with `--local` appended, then called `job.waitUntilFinished(queueEvents)` to block and wait.

3. **Chained timeout**: The outer job (Job ID 2) had a 2-hour timeout (7200000ms, the default). The inner job (re-submitted with `--local`) ran the actual eval work — creating 3 git worktrees, installing dependencies, and running evaluations for 3 SHAs in parallel. The combined overhead of queue re-submission + actual eval work exceeded the outer job's 2-hour timeout.

4. **Timeout fires**: At 04:56:07 UTC (exactly ~2 hours after worker startup at 02:55:33 UTC), the `setTimeout` in `eval.worker.ts` (line 97-101) fired, killed the child process with `SIGTERM`, and rejected the promise with "Command timed out after 7200000ms".

**Contributing factor — no recursive submission guard**: The eval worker (`eval.worker.ts` line 53) passes `process.env` directly to the child process without any marker indicating it's already running inside a worker. There is no safeguard to prevent the spawned `eval.ts` process from re-submitting to the queue.

**Contributing factor — timeout timer leak**: The `setTimeout` at line 97 is never cleared when the child process exits normally (via the `close` event at line 80). Conversely, when the timeout fires and kills the child, the subsequent `close` event handler still runs and attempts a second `reject()` (which is a no-op but wastes resources on the `await job.log()` call).

## Fix

**Primary fix** — Prevent recursive queue submission by having the eval worker signal to child processes that they are already running inside a worker:

In `eval.worker.ts`, set an environment variable in the child process:
```typescript
const child = spawn('/bin/bash', ['-c', command], {
    cwd: mewtwoPath,
    env: { ...process.env, EVAL_RUNNING_IN_WORKER: 'true' },
    shell: false,
});
```

In `eval.ts`, check this environment variable in the `shouldRunRemote` logic:
```typescript
const isRunningInWorker = process.env.EVAL_RUNNING_IN_WORKER === 'true';
const shouldRunRemote = !isRunningInWorker && !options.local && options.remote !== false;
```

**Secondary fix** — Clean up the timeout timer to prevent leaks and race conditions:
```typescript
let timeoutTimer: NodeJS.Timeout | null = null;

child.on('close', async (code) => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    clearInterval(flushTimer);
    if (outputBuffer.trim()) {
        await job.log(outputBuffer);
    }
    if (code === 0) {
        resolve();
    } else {
        reject(new Error(`Command failed with exit code ${code}`));
    }
});

if (timeout) {
    timeoutTimer = setTimeout(() => {
        clearInterval(flushTimer);
        child.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
}
```

---
