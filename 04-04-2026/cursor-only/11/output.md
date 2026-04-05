## TL;DR
The eval worker was re-deployed to production (via `tv.worker.ts`) as a BullMQ consumer for `eval-queue`, but the corresponding producer code that enqueues jobs with a `command` field was never re-added — so the worker picked up a stale/orphaned job from Redis that lacked the required `command` field.

## What Broke and Why

The eval queue infrastructure went through a rapid add/remove/re-add cycle over Jan 14–16, creating a consumer-without-producer situation:

1. **Jan 14 — commit `4250670b` (#166):** Added `eval.worker.ts`, `eval.queue.ts`, and remote execution logic in `eval.ts`. The CLI defaulted to remote execution — running `yarn eval run` without `--local` would call `evalQueue.add('run-eval', { command, timeout })`, enqueuing a job to the `eval-queue` in whatever Redis the environment was connected to. The TV worker Dockerfile was also updated (`c567c1a4`, #167) to start the eval worker in production.

2. **Jan 15 — commit `2463f0cc` (#175):** The `evals.yml` CI workflow was patched to add `--local` to prevent accidental remote enqueuing. This implies that during the ~24-hour window (Jan 14–15), at least one invocation of `yarn eval run` without `--local` could have occurred — either from the scheduled cron (weekdays at 12:00 UTC), a manual `workflow_dispatch`, or a developer running from a context with production Redis credentials. Any such invocation would have enqueued a job to the `eval-queue`.

3. **Jan 16 11:01 — commit `8dc06894` (#176):** Removed the entire remote execution infrastructure: deleted `eval.queue.ts`, `eval.worker.ts`, and the `--remote`/`--local`/`--timeout` CLI flags. Removed `eval.worker` import from `tv.worker.ts`. However, **the stale job(s) remained in the production Redis `eval-queue`** — BullMQ persists jobs in Redis independently of application code.

4. **Jan 16 12:44 — commit `0dfbac01` (#179):** Re-added `eval.worker.ts` and `eval.queue.ts` with a new `EvalJobData` interface (only `command: string`, no `timeout`). Re-added `import './eval.worker'` to `tv.worker.ts`. **Critically, no producer code was re-added** — the `runBraintrustEval()` function in `eval.ts` only spawns local processes, never calling `evalQueue.add()`.

5. **Jan 16 23:26 — the error:** The newly deployed TV worker started the eval worker, which connected to production Redis and immediately began processing jobs from the `eval-queue`. It found a stale/orphaned job whose `data` object did not contain a `command` field (or contained a falsy value). The validation at line 42–43 of `eval.worker.ts` threw `Error: Job data must include "command" field`.

The stale job likely originated from the Jan 14–15 window, and its data was either corrupted during the queue teardown/recreation cycle, or it was a BullMQ internal artifact (e.g., a stalled job marker) left behind when the worker was abruptly removed during deployment. BullMQ stores queue state (including waiting, active, delayed, and stalled jobs) as Redis keys that persist across application deployments and code changes.

## Fix

**Immediate fix — remove the orphaned eval worker from the TV worker deployment**, since there is no producer code to create valid jobs:

In `mewtwo/src/workers/tv.worker.ts`, remove the eval worker import:

```typescript
// Remove these lines:
// Import and start eval worker
import './eval.worker';
```

And update the log message accordingly. Also drain the stale `eval-queue` jobs from production Redis:

```bash
# Via redis-cli or a one-off script:
# Delete all eval-queue keys to clean up stale state
redis-cli KEYS "bull:eval-queue:*" | xargs redis-cli DEL
```

**If remote eval execution is still desired**, the producer code (`evalQueue.add()`) must be re-added to `mewtwo/src/bin/eval.ts` behind an explicit `--remote` flag (never as the default behavior), and the `EvalJobData` interface must match between producer and consumer. The original implementation's mistake of defaulting to remote execution (`shouldRunRemote = !options.local && options.remote !== false`) should not be repeated — remote execution should be opt-in only.
