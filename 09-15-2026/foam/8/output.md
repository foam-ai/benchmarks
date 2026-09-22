[Foam Trace ID: e9c2051aa56bdd8d92de1ff67fcd1c65] ## TL;DR

This is not a bug: the E11000 error is the intended behaviour of the distributed lock. Two concurrent webhooks for the same resource raced; the unique index rejected the second insert, which then waited, retried, acquired the lock and completed normally.

## What Broke and Why

**Observed error:** `MongoServerError: E11000 duplicate key error collection: locks index: resource_1`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** The lock implementation relies on the unique index on `resource` to guarantee mutual exclusion.

**2.** The run for the second webhook is `completed` a few seconds later in the same trace.

## Fix

- No fix required. Optionally catch E11000 inside the lock helper so it is not reported to Sentry as an unhandled exception.


---
