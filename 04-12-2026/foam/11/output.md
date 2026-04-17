[Foam Trace ID: 83517e94c7181e7f60481048e8790c9e] ## TL;DR

A BullMQ eval job (job ID 19) was manually enqueued to `eval-queue` with an empty payload `{}`, bypassing all TypeScript type safety. Because no application code in the repo ever calls `evalQueue.add()`, the job must have been added externally (Redis CLI, a BullMQ REPL session, or an external queue GUI). The worker's consumer-side guard fired correctly — this is not a code bug, but a misuse of the queue by an external/manual operator.

---

## What Broke and Why

### 1. A job arrived at the eval worker with no data

Telemetry for the failing span confirms the job payload was completely empty at the moment of dequeue:

```
2026-01-16 23:26:25.910  INFO  src/workers/eval.worker.ts:37
[eval-worker] Processing eval job 19 {}
```

`job.data` was `{}` — the `command` field was not null or undefined-after-assignment, it was simply never present in the object stored in Redis.

### 2. The worker's validation guard fired as designed

In `eval.worker.ts`:
```typescript
const { command } = job.data;   // undefined — field does not exist
if (!command) {
    throw new Error('Job data must include "command" field');  // ← fires here
}
```

This is correct defensive code. The guard exists precisely because no typed producer enforces the schema at enqueue time.

### 3. There is no application-level enqueue path — the job came from outside the codebase

A full audit of the repo finds that `evalQueue` (the BullMQ queue singleton from `eval.queue.ts`) is only:
- **Defined** in `eval.queue.ts`
- **Consumed** in `eval.worker.ts`

It is **never imported or called** by any router, service, scheduler, HTTP handler, or CLI script in the codebase. Specifically:

- The GitHub Actions workflow runs `yarn mewtwo run eval run --local`, which invokes `bin/eval.ts` → directly `spawn()`s braintrust commands **without touching BullMQ at all**
- No Bull Board / Arena / Taskforce admin UI is installed or mounted
- No HTTP route exposes a job-add endpoint for `eval-queue`
- No ops/admin script calls `evalQueue.add()`

The only way job 19 could have reached `eval-queue` is via an **external, untraced, untyped operation** — e.g., a Redis CLI `RPUSH`, a raw `ioredis` REPL session, or a third-party BullMQ GUI. This is corroborated by the trace: **there is no producer/enqueue OTel span anywhere in the telemetry for this job**, confirming it was added outside the instrumented application entirely.

### 4. Full causal chain

```
External actor manually enqueues job to `eval-queue` via Redis/BullMQ tooling
    → Job payload is {} (no `command` field supplied)
    → No producer-side type enforcement or validation exists (evalQueue.add() is never called in-app)
    → Worker dequeues job 19, logs job.data as {}
    → const { command } = job.data  →  command === undefined
    → if (!command) fires
    → throw new Error('Job data must include "command" field')
    → Job marked as failed in Redis
```

---

## Fix

**No Code Changes Required.** The worker validation guard functioned exactly as intended. This error was caused by an external operator manually enqueuing a job to `eval-queue` with an empty payload `{}`, bypassing the TypeScript `EvalJobData` interface entirely.

### Prevention

The operator who adds jobs to `eval-queue` must include the `command` field. The required payload is:

```json
{
  "command": "yarn eval run --experiments default,deep-research-5-phases"
}
```

`command` must be a **non-empty string** containing the complete shell command for the worker to execute.

**Example — correct BullMQ job addition (TypeScript):**
```typescript
import { evalQueue } from '../queues/eval.queue';

await evalQueue.add('run-eval', {
    command: 'yarn eval run --experiments default,deep-research-5-phases'
});
```

**Example — if adding via Redis CLI directly (strongly discouraged):**
```
CALL BullMQ:eval-queue:add ...  ← must include {"command":"<shell command>"}
```

### Optional Enhancement (not a fix)

To prevent a recurrence and close the gap between the queue infrastructure and its only real consumers, the team should add a typed, application-level producer that calls `evalQueue.add()` with a validated `EvalJobData` payload — either as a CLI command (`bin/enqueue-eval.ts`) or as an internal service method. This would make the TypeScript interface the enforced contract and would prevent empty-payload jobs from ever reaching the worker regardless of external tooling.


---
