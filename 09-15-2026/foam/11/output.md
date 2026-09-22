[Foam Trace ID: c59253e0f668c0544043b66e9d468fec] ## TL;DR

A job was enqueued to `eval-queue` with empty data `{}`, omitting the required `command` field; the worker validation caught it immediately. Nothing in the code is broken — the job was simply enqueued incorrectly.

## What Broke and Why

**Observed error:** `Error: Invalid eval job data: missing required field 'command'`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** The failing job payload in Redis is literally `{}`.

**2.** `EvalJobData` validation runs on dequeue and fails fast.

## Fix

- Fix the producer (manual enqueue / script) to include `command`; optionally validate on `add()` as well.


---
