## TL;DR
The eval worker received a BullMQ job with empty data `{}` because no producer code exists in the codebase to properly enqueue eval jobs — the queue/worker were deployed to production without a corresponding job-submission mechanism, and a manually-added job lacked the required `command` field.

## What Broke and Why
The eval queue system (`mewtwo/src/queues/eval.queue.ts` + `mewtwo/src/workers/eval.worker.ts`) was deployed to production as part of the TV worker (`mewtwo/src/workers/tv.worker.ts` imports `./eval.worker`), but the producer side — code that adds jobs to the `eval-queue` with valid `EvalJobData` (containing a `command: string` field) — was never implemented. A search of the entire codebase confirms that `evalQueue` is never imported for job addition anywhere; the only references are the queue definition itself and the worker consumer.

The causality chain:
1. **Partial implementation deployed**: The eval queue definition and worker exist, but no service, API endpoint, or CLI command adds jobs to this queue programmatically. The `evalQueue.add()` is only mentioned in a code comment.
2. **Worker deployed to production**: `tv.worker.ts` imports both `./issue-solver.worker` and `./eval.worker`, so the eval worker is active on the production ECS `mewtwo-tv` service, listening on `eval-queue` in production Redis.
3. **Job added externally with invalid data**: Job 19 was added to the eval-queue with an empty object `{}` as its data, missing the required `command` field. This was likely done via Bull Board (configured as `addono/bull-board` in both `docker-compose.yml` and `docker-compose.tv-reverse-proxy.yml` on port 3020, connected to the same Redis), direct Redis CLI, or an external script.
4. **Worker validation caught the error**: The worker destructured `job.data` to extract `command` (which was `undefined`), the `if (!command)` check triggered, and it threw `Error: Job data must include "command" field`.
5. **BullMQ failure handler reported to Sentry**: The worker's `failed` event handler called `Sentry.captureException(err)`, creating MEWTWO-52.

The breadcrumbs confirm the timeline: the TV worker started at `22:47:11 UTC`, the eval worker connected to Redis and became READY at `22:47:12 UTC`, then ~39 minutes later at `23:26:25 UTC` it picked up job 19 with empty data `{}` and failed.

## Fix
**Immediate fix** — Add a validated producer function to `eval.queue.ts` that enforces the required `command` field at runtime, preventing jobs with invalid data from being enqueued:

```typescript
// mewtwo/src/queues/eval.queue.ts
import { z } from 'zod';
import { MonitoredQueue } from './monitored-queue';

const evalJobDataSchema = z.object({
    command: z.string().min(1, 'command must be a non-empty string'),
});

export interface EvalJobData {
    command: string;
}

export const evalQueue = new MonitoredQueue<EvalJobData>('eval-queue', {
    defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 60 * 60 * 24 * 7, count: 100 },
        removeOnFail: { age: 60 * 60 * 24 * 30 },
    },
    monitoring: {
        queueDepthThreshold: 10,
        failedCountPerHourThreshold: 5,
    },
});

export async function addEvalJob(command: string, jobName?: string) {
    const validated = evalJobDataSchema.parse({ command });
    return evalQueue.add(jobName || `eval-${Date.now()}`, validated);
}
```

**Structural fix** — Until a proper producer (API endpoint, Slack command, or service function) is implemented to submit eval jobs, remove the premature eval worker from the production TV worker to prevent it from picking up improperly formed jobs:

```typescript
// mewtwo/src/workers/tv.worker.ts
import './issue-solver.worker';
// Remove: import './eval.worker';  // Re-add when producer is ready
```

---
