[Foam Trace ID: 9fa6eac7ed37fd89f79cc10a90ebbd14] ## TL;DR

Job 19 on the `eval-queue` was enqueued with a completely empty data payload `{}`, causing the eval worker's `if (!command)` validation to throw `'Job data must include "command" field'`. The root cause is the absence of enqueue-time validation on the producer side, which allowed an empty payload to enter the queue. The fix is to add schema validation at the point where jobs are added to the `eval-queue`.

## What Broke and Why

The eval worker at `mewtwo/src/workers/eval.worker.ts` processes jobs from the `eval-queue` BullMQ queue. When it picked up job 19, the log at line 37 confirms the payload was completely empty:

```
2026-01-16 23:26:25.910 INFO [eval-worker] Processing eval job 19 {}
```

The worker then attempted to destructure the `command` field:

```typescript
const { command } = job.data;          // line 40 — command is undefined

if (!command) {                         // line 42 — truthy check catches undefined
    throw new Error('Job data must include "command" field');  // line 43
}
```

Since `job.data` was `{}`, `command` destructured as `undefined`, the guard triggered, and the error was thrown. BullMQ marked the job as failed (confirmed by the `fail eval-queue` sibling span, duration 2.36ms).

**The worker-side validation is working correctly** — it properly rejects malformed jobs. The real problem is upstream: **the producer that enqueued job 19 sent a completely empty `{}` payload**, and nothing prevented that empty payload from entering the queue.

Key evidence that the issue is on the write path:
- The payload is `{}` — not partially formed (e.g., a misspelled field or null value), but entirely empty. This rules out a field rename or type mismatch.
- **No producer-side telemetry exists**: the trace starts at the consumer span `process eval-queue` (Kind: Consumer, SpanId: `bdacff7479edc839`). There is no grandparent span, no producer span, and no HTTP/API request span. The enqueueing operation is completely uninstrumented.
- **No enqueue-time validation exists**: BullMQ's `.add()` method accepts any object as job data. The only validation is the runtime `if (!command)` check at line 42 inside the worker — there is no schema validation (Zod, Joi, etc.), no TypeScript runtime type enforcement, and no middleware between the `.add()` call and the worker callback.
- The low job ID (19) and completely empty payload are consistent with manual job creation (e.g., via a Bull Board admin dashboard), a test/script, or a code bug where the payload variable was uninitialized or defaulted to `{}`.

**Alternative hypothesis considered**: Could BullMQ serialization have lost the data? This is unlikely — BullMQ uses standard JSON serialization for job data, which would not silently convert a populated object to `{}`. The empty payload was almost certainly enqueued as `{}` from the start.

## Fix

Add **enqueue-time validation** at every code path that adds jobs to the `eval-queue`. This prevents invalid payloads from entering the queue in the first place.

**1. Create a validated enqueue function** (primary fix):

```typescript
import { Queue } from 'bullmq';
import { z } from 'zod';

const EvalJobDataSchema = z.object({
  command: z.string().min(1, 'command must be a non-empty string'),
});

type EvalJobData = z.infer<typeof EvalJobDataSchema>;

export async function addEvalJob(queue: Queue, data: EvalJobData, opts?: JobsOptions) {
  const validated = EvalJobDataSchema.parse(data); // throws ZodError if invalid
  return queue.add('eval', validated, opts);
}
```

All producers must use `addEvalJob()` instead of calling `queue.add()` directly. This ensures that any call with `{}` or missing `command` is rejected *before* the job enters Redis, preventing the error entirely.

**2. Keep the worker-side guard** as defense-in-depth (existing code, no change needed):

```typescript
if (!command) {
    throw new Error('Job data must include "command" field');
}
```

**Why this fix breaks the causal chain**: The error occurs because an empty `{}` payload reaches the worker. With enqueue-time validation, the `.add()` call itself would throw a `ZodError` when `command` is missing, so the job never enters the queue, and the worker never sees it. The worker-side guard becomes a safety net rather than the primary defense.

**3. Add producer-side OpenTelemetry instrumentation** (recommended enhancement): Instrument the BullMQ producer with `@opentelemetry/instrumentation-bullmq` to propagate trace context from producer to consumer. This would make future enqueueing operations traceable, enabling faster root cause identification if similar issues recur.

---
