## TL;DR

The eval worker correctly rejected BullMQ job 19 because it was enqueued to `eval-queue` with empty data (`{}`) — missing the required `command` field. **No code in the repository enqueues jobs to this queue**; the job was most likely created manually via the Bull Board dashboard (exposed on port 3020) or direct Redis access, without providing the required payload.

## What Broke and Why

The error `Job data must include "command" field` was thrown by the eval worker's explicit validation guard in `/mewtwo/src/workers/eval.worker.ts`:

```typescript
const { command } = job.data;

if (!command) {
    throw new Error('Job data must include "command" field');
}
```

Telemetry confirms job 19's data was a completely empty object:
```
[eval-worker] Processing eval job 19 {}
```

The `EvalJobData` interface requires a `command: string` field:
```typescript
export interface EvalJobData {
    command: string; // Full command to run
}
```

However, this TypeScript type provides no runtime enforcement. The only runtime validation is the `if (!command)` truthiness check in the worker processor, which fired correctly.

**Why was the job enqueued with empty data?** A comprehensive search of the entire codebase reveals that **`evalQueue.add()` is never called anywhere** — zero producers exist. The `evalQueue` object is exported from `eval.queue.ts` but never imported by any router, service, scheduler, or script. The GitHub Actions workflow (`evals.yml`) and the CLI tool (`yarn eval run`) both execute evals directly via `spawn` without using the BullMQ queue.

No telemetry `add eval-queue` span exists for this job (confirmed by querying for `bullmq.queue.operation = 'add'`), indicating the job was enqueued without application-level tracing — consistent with external/manual creation.

The most probable enqueuing mechanism is the **Bull Board dashboard** (`addono/bull-board`), which is configured in two docker-compose files with direct Redis access on port 3020:

```yaml
bull-board:
    image: addono/bull-board
    ports:
        - '3020:3000'
    environment:
        - REDIS_HOST=redis
        - REDIS_PORT=6379
```

This dashboard discovers all BullMQ queues in Redis (including `eval-queue`) and allows manual job creation and retry operations via its UI — without enforcing the `EvalJobData` schema.

**Alternative hypothesis considered and eliminated:** Could a BullMQ automatic retry or MonitoredWorker/MonitoredQueue re-enqueue logic have stripped the job data? No — `MonitoredWorker` and `MonitoredQueue` are thin wrappers that perform zero data transformation, and the queue is configured with `attempts: 1` (no automatic retries). No re-enqueue, retry, or data-manipulation logic exists in either class.

## Fix

**No code bug exists.** The worker validation worked exactly as designed — it correctly rejected a malformed job. The root cause is an externally-created job with missing required data, enqueued outside of any application code path (most likely via the Bull Board dashboard or direct Redis manipulation).

**No Code Changes Required.**

### Prevention

To prevent recurrence and improve robustness:

1. **Required payload for manual job creation:** Any manual enqueue to `eval-queue` must include the `command` field:
   ```json
   { "command": "yarn eval run --experiments default" }
   ```

2. **(Recommended enhancement) Add runtime schema validation at enqueue time:** Wrap `evalQueue.add()` in a helper function with Zod validation so that any future producer (or a manually-called script) is forced to provide valid data:
   ```typescript
   const EvalJobDataSchema = z.object({ command: z.string().min(1) });
   
   export async function addEvalJob(name: string, data: unknown) {
       const validated = EvalJobDataSchema.parse(data);
       return evalQueue.add(name, validated);
   }
   ```

3. **(Recommended enhancement) Restrict Bull Board access:** The Bull Board dashboard currently has unrestricted access to Redis and all queues. Consider adding authentication or restricting it to non-production environments to prevent accidental malformed job creation in production.

---