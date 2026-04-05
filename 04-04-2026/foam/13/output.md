## TL;DR

The eval worker's child process called `job.waitUntilFinished(queueEvents)` **without a TTL**, relying entirely on Redis pub/sub to detect when downstream Job 7 completed or failed. Job 7 failed within 20 seconds (because the ECS container has no `.git` directory), but the `QueueEvents` pub/sub subscription missed the `failed` event, causing `waitUntilFinished` to hang indefinitely. The eval worker's 2-hour `setTimeout` was the only backstop, producing the observed `Command timed out after 7200000ms` error.

## What Broke and Why

The failure involves a **nested job submission architecture** with a fatal gap in failure propagation:

**Step 1 — Job 2 picks up a remote eval command.** The eval worker (Job ID `2`) received a command without the `--local` flag:
```
yarn eval run --sha 80a148e05a63ed59d9aee3c2d8675f9b7b9ae8f5 --sha fea37535fba35939fb7ffdf3cba661c3c003e6ac --sha a12dc06bf21444d0b8354b03943a5f24345a4912
```
The worker spawned this as a child process via `spawn('/bin/bash', ['-c', command], { cwd: mewtwoPath })` and set a 2-hour timeout (`timeout = 7200000`).

**Step 2 — Child process submits a nested Job 7.** Inside the child process, `eval.ts` detected `shouldRunRemote = true` (no `--local` flag), built a new command with `--local` prepended, and submitted it to the same `eval-queue`:
```
📝 Command: yarn eval run --local --sha 80a148e... --sha fea37535... --sha a12dc06b... -m 20
✅ Job 7 submitted
⏳ Waiting for completion...
```
It then called `await job.waitUntilFinished(queueEvents)` — **with no TTL argument** — to wait for Job 7.

**Step 3 — Job 7 failed immediately.** The `--local --sha` code path requires a git repository to create worktrees for each SHA. The ECS container image (`Dockerfile.tv-worker`) uses `COPY mewtwo/ ./mewtwo/` which **never includes the `.git` directory**. The pre-flight check in `git-operations.ts` ran:
```
git status --porcelain
fatal: not a git repository (or any of the parent directories): .git
```
Job 7 failed with exit code 1 after 3.5 seconds (attempt 1 at `02:56:18`, attempt 2 at `02:56:26`). After exhausting both retry attempts (`attempts: 2` in queue config), Job 7 moved to BullMQ's final `failed` state at ~`02:56:27`.

**Step 4 — The `waitUntilFinished` call missed the failure event.** BullMQ's `waitUntilFinished` relies on Redis pub/sub (fire-and-forget semantics). The `QueueEvents` instance was created at ~`02:56:14` and needed to establish a Redis pub/sub subscription. Job 7's final `failed` event was published at ~`02:56:27`. The telemetry proves the event was missed: the child process's `catch` block (which would print `❌ Eval failed:` and call `process.exit(1)`) **never executed**. Instead, complete silence followed for 2 hours. The `logPolling` `setInterval` (every 2 seconds) kept the Node.js event loop alive, preventing the child process from exiting naturally:

```typescript
// eval.ts — the unbounded wait
try {
    await job.waitUntilFinished(queueEvents);  // NO TTL — hangs forever if event missed
    clearInterval(logPolling);
    process.exit(0);
} catch (error) {
    clearInterval(logPolling);               // Never reached
    console.error('\n❌ Eval failed:', error); // Never printed
    process.exit(1);                          // Never called
}
```

**Step 5 — 2-hour timeout fired.** The eval worker's `setTimeout` in `eval.worker.ts:100` was the only protection:
```typescript
setTimeout(() => {
    clearInterval(flushTimer);
    child.kill();
    reject(new Error(`Command timed out after ${timeout}ms`));
}, timeout);  // timeout = 7200000
```
At `04:56:07` (exactly 2 hours after start), this fired, killed the hung child process, and produced the observed error: `Error: Command timed out after 7200000ms`.

**Alternative hypothesis considered and eliminated:** The initial hypothesis was that the 2-hour timeout simply wasn't long enough for the eval work. This was disproven by telemetry showing Job 7 failed in 3.5 seconds — the actual work was done almost immediately. The timeout was caused by a failure-propagation bug, not slow work.

## Fix

**Primary fix — Add a TTL to `waitUntilFinished` and implement state-polling fallback in `eval.ts`:**

```typescript
// eval.ts — pass a TTL and add periodic state checking
const WAIT_TTL = 7100000; // slightly less than worker timeout to allow clean exit

const logPolling = setInterval(async () => {
    try {
        // Fetch and relay logs
        const logs = await evalQueue.getJobLogs(job.id!);
        const newLogs = logs.logs.slice(lastLogCount);
        if (newLogs.length > 0) {
            console.log(newLogs.join('\n'));
            lastLogCount = logs.logs.length;
        }
        // Fallback state check — don't rely solely on pub/sub
        const jobState = await job.getState();
        if (jobState === 'failed' || jobState === 'completed') {
            clearInterval(logPolling);
            if (jobState === 'failed') {
                console.error('\n❌ Eval failed (detected via polling)');
                process.exit(1);
            }
            process.exit(0);
        }
    } catch { /* Ignore errors */ }
}, 2000);

try {
    await job.waitUntilFinished(queueEvents, WAIT_TTL);
    // ...
```

This fix breaks the causal chain at two points:
1. **TTL on `waitUntilFinished`** ensures the call cannot hang indefinitely even if the pub/sub event is missed — it will time out and throw after the specified duration.
2. **Periodic state polling** (checking `job.getState()` every 2 seconds alongside log fetching) provides a reliable fallback that doesn't depend on Redis pub/sub. If Job 7 fails within 3.5 seconds, the next polling cycle at 4 seconds would detect it and exit immediately — eliminating the 2-hour hang entirely.

**Secondary fix — Validate environment compatibility before submitting `--local --sha` jobs:**

In the remote submission path of `eval.ts`, add a note/check that `--sha` mode requires git worktrees and is incompatible with containerized workers. Either skip the `--sha` flags when submitting to the remote queue, or implement a container-compatible SHA comparison strategy (e.g., fetching code via API rather than git worktrees). This prevents the guaranteed-to-fail command from being enqueued in the first place.

---