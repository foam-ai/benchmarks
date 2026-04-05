## TL;DR
Incomplete code change in `issue-solver/index.ts` replaced `SimpletonAgent` with `DeepResearchAgent` but never called `agent.run()` and left dangling references to the now-undefined `result` variable, causing the eval process to crash on invocation and hang without exiting cleanly until the 2-hour timeout killed it.

## What Broke and Why
Commit `c816cd77` made an incomplete refactor in `mewtwo/src/services/issue-solver/index.ts` to swap `SimpletonAgent` for the new `DeepResearchAgent`. The change commented out both the old agent instantiation **and** the `result` assignment:

```typescript
// const agent = new SimpletonAgent(run);
// const result = (await agent.run()) as {
//     success: boolean;
//     report?: string;
//     errorMessage?: string;
// };
```

It then created the new `DeepResearchAgent` but **never called `agent.run()`** on it:

```typescript
const agent = new DeepResearchAgent({ run, foamIssue });
```

Critically, the code immediately below still references the `result` variable on lines 60, 65, and 76 — which no longer exists:

```typescript
log().debug('Run solve completed', {
    runId: run.runId,
    success: result.success,  // ReferenceError: result is not defined
});
```

This causes a `ReferenceError` at runtime whenever `runIssueSolver()` is invoked. The causality chain for the timeout:

1. An eval job was submitted to the `eval-queue` with the default 7200000ms (2-hour) timeout.
2. The eval worker (`eval.worker.ts`) spawned a child process to run the eval command (e.g., `yarn eval run --local`).
3. The eval process started, initialized connections to external services (Braintrust API, MongoDB, Redis), and began executing eval test cases.
4. When the eval invoked the issue solver, it hit the `ReferenceError` on the undefined `result` variable and crashed for that test case.
5. The eval process failed to exit cleanly — open handles from database connections, API clients, and BullMQ kept the Node.js event loop alive indefinitely.
6. After 2 hours, the eval worker's `setTimeout` fired and killed the child process via `child.kill()` (SIGTERM), then rejected the promise with `Command timed out after 7200000ms`.

A secondary contributing factor is a bug in the eval worker's timeout handling: the `setTimeout` timer reference is never stored, so it cannot be cleared when the child process exits normally. Additionally, `child.kill()` only sends SIGTERM (not SIGKILL), which may not terminate the entire process tree when bash spawns nested child processes.

## Fix
**Primary fix** — Complete the code change in `mewtwo/src/services/issue-solver/index.ts` by calling `agent.run()` and assigning the result:

```typescript
const agent = new DeepResearchAgent({ run, foamIssue });
const result = (await agent.run()) as {
    success: boolean;
    report?: string;
    errorMessage?: string;
};
```

**Secondary fix** — Harden the timeout handling in `mewtwo/src/workers/eval.worker.ts` to store the timer reference and clear it when the child exits:

```typescript
let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

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
        child.kill('SIGKILL');
        reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
}
```
