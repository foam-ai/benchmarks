## TL;DR
Eval worker deployed in production with no producer code — an orphaned BullMQ queue consumed a job with empty data `{}` missing the required `command` field.

## What Broke and Why

### The Error
The eval worker (`eval.worker.ts:43`) threw `Error: Job data must include "command" field` when processing job ID 19 from the `eval-queue`. The worker logs confirmed the job data was an empty object `{}`:
```
[eval-worker] Processing eval job 19 {}
```

### Root Cause: Incomplete Refactoring Left an Orphaned Queue Consumer

A rapid series of commits on January 16, 2026 created a **producer-consumer mismatch** in the eval queue infrastructure:

1. **Commit `4250670b` (#166, Jan 14)** — Added the eval worker + queue with a `--remote` CLI flag that dispatched jobs via `evalQueue.add('run-eval', { command: "yarn eval run --local ..." })`. This was the **only producer** for the `eval-queue`.

2. **Commit `8dc06894` (#176, Jan 16, 11:01 AM PST)** — **Deleted** `eval.queue.ts` and `eval.worker.ts` entirely as part of "Remove remote eval execution infrastructure". The `eval.ts` CLI was simplified to only run evals locally via `child_process.spawn`.

3. **Commit `0dfbac01` (#179, Jan 16, 12:44 PM PST)** — **Re-added** `eval.queue.ts` and `eval.worker.ts` as part of "Add experiment variants to eval system", but **did NOT restore the producer code** that dispatches jobs to the queue. The `evalQueue` object is exported from `eval.queue.ts` but never imported by any code.

4. **Commit `2844c49a` (#183, Jan 16, 2:34 PM PST)** — The error commit. Only adds `suffix: options.suffix` to `runBraintrustEval()`. The eval CLI still runs evals directly as child processes, never touching the queue.

At this commit, the state of the codebase is:
- **`tv.worker.ts` (line 18)**: `import './eval.worker'` — starts the eval worker in production ECS
- **`eval.worker.ts`**: Consumes from `eval-queue`, expects `{ command: string }` in job data
- **`eval.queue.ts`**: Defines and exports `evalQueue`, but **nothing in the codebase imports it to add jobs**
- **`eval.ts`** (CLI): Runs evals via `child_process.spawn` directly — no queue interaction

### How the Empty Job Got There
With the eval worker running in production but no proper producer code, job 19 was likely added through one of:
- The **Bull Board admin UI** (configured in `docker-compose.yml` on port 3020) used for manual testing without filling in the `command` field
- A **manual Redis insertion** or API test
- A **stale job** from the brief period when the old remote dispatch code existed (commits #166–#176), though those would typically have had the `command` field populated

### Telemetry Evidence
- **Trace ID**: `4551d102cd4a8be3c8d1308115e1da20`
- **Root span**: `process eval-queue` (BullMQ Consumer) — duration 21.4ms (failed fast)
- **Worker ID**: `297316ab-7dd9-4de8-82ee-af8085ecee3b`
- **Job ID**: 19
- **Environment**: Production ECS on AWS (us-west-1, AMD EPYC 7571, Debian)
- **Failure path**: Worker started → logged `job.data` as `{}` → destructured `command` → validation check `if (!command)` → threw Error → BullMQ marked job as failed in Redis

## Fix

### Immediate Fix: Remove the orphaned eval worker from production

In `mewtwo/src/workers/tv.worker.ts`, remove line 18 (`import './eval.worker'`) since nothing dispatches jobs to the `eval-queue`:

```typescript
// mewtwo/src/workers/tv.worker.ts
import log from '../logging';
import { ENVIRONMENT } from '../keys';

console.log('[tv-worker] Loading worker...');
log().info('Starting Terminal Velocity workers', { environment: ENVIRONMENT });

import './issue-solver.worker';

// REMOVED: import './eval.worker' — no producer exists for eval-queue

console.log('[tv-worker] Workers initialized (issue-solver)');
```

### If Remote Eval Execution Is Needed: Restore the Producer

Add queue dispatch back to `eval.ts` by re-adding the `--remote` flag:

```typescript
// In eval.ts, inside the run command action:
if (options.remote) {
    const { evalQueue } = await import('../queues/eval.queue');
    const command = `yarn eval run --experiments ${options.experiments}${options.suffix ? ` --suffix ${options.suffix}` : ''}`;
    await evalQueue.add('run-eval', { command });
    return;
}
```

### Preventive Fix: Add Zod Validation at Enqueue Time

In `eval.queue.ts`, validate job data before it enters the queue:

```typescript
import { z } from 'zod';
import { MonitoredQueue } from './monitored-queue';

const EvalJobDataSchema = z.object({
    command: z.string().min(1, 'command is required'),
});

export type EvalJobData = z.infer<typeof EvalJobDataSchema>;

class ValidatedEvalQueue extends MonitoredQueue<EvalJobData> {
    async add(name: string, data: EvalJobData, opts?: object) {
        EvalJobDataSchema.parse(data);
        return super.add(name, data, opts);
    }
}

export const evalQueue = new ValidatedEvalQueue('eval-queue', { /* ... */ });
```

---
