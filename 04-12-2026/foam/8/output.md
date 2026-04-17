[Foam Trace ID: 86c97f160b069d48221ea55fb6c59b3f] ## TL;DR

The E11000 duplicate key error on `foam_db.lock` is **not a bug** — it is the intentional "lock already held" signal in the distributed locking mechanism. `withLock()` explicitly catches E11000 and retries successfully after 1 second; the request completed normally. The error surfaces in monitoring because the `mongoose.Lock.save` OTel span is marked with Error status when the exception propagates through Mongoose's instrumentation, even though the application catches and handles it before it reaches the caller.

## What Broke and Why

### The Distributed Lock Design

The system uses MongoDB's `foam_db.lock` collection as a distributed mutex. The lock is acquired by calling `lockColl.createLock()` inside `withLock()` (`lock.service.ts`), which calls `new Lock(lockDoc).save()` against a **compound unique index** on `{ customerId, type, resourceId }`:

```ts
LockSchema.index(
    { customerId: 1, type: 1, resourceId: 1 },
    { unique: true, name: 'customerId_1_type_1_resourceId_1' }
);
```

When the lock is already held by another request, MongoDB rejects the insert with `E11000 duplicate key error` — this is the intentional lock-contention signal, not an unexpected failure.

### What Happened in This Request

A `POST /sentry/webhook` request arrived for a Sentry `event_alert` triggered by resource `7202529779` for `customerId=68225b7c65937a6a6f391d1d`. The webhook handler (at `routers/sentry/webhook.ts:169`) calls `withLock()` exactly once:

```ts
await withLock(customerId, issueId, 'webhook', 30 * 60 * 1000, async () => {
    // ... handle webhook ...
    log().info('Received and ignored webhook action', { resource });
    res.sendStatus(202);
});
```

At `23:20:32.481`, the first `lock.save()` attempt (span s8: `mongoose.Lock.save`) was rejected with E11000 — a concurrent request already held the lock for the same `(customerId, type=webhook, resourceId=7202529779)` tuple. The telemetry log confirms:

```
23:20:32.502 — DEBUG lock.service.ts:69: "Lock already exists for customerId: 68225b7c65937a6a6f391d1d and resourceId: 7202529779"
```

`withLock()` caught this explicitly:

```ts
} catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
        // Duplicate key error, lock already exists
        log().debug(`Lock already exists for customerId: ${customerId}...`);
        await sleep(SLEEP_TIME);  // 1000ms
        timeWaiting = Date.now() - startTime;
        // continue retry loop
    } else {
        log().error(`Error acquiring lock...`, error);
        throw error;  // only non-11000 errors rethrow
    }
}
```

After a 1-second sleep, the second attempt at `23:20:33.503` succeeded (the competing request had released the lock):

```
23:20:33.527 — DEBUG lock.service.ts:62: "Acquired lock for customerId: 68225b7c65937a6a6f391d1d and resourceId: 7202529779"
```

The webhook was processed (classified as an ignored `event_alert` action), and the lock was cleanly released via `deleteOne` at `23:20:33.548`. The parent span `POST /sentry/webhook` completed successfully (Status=Unset, duration=1.21s).

### Why the Error Appeared in Monitoring

The `mongoose.Lock.save` OTel span (s8) is marked with **Error status** when the `MongoServerError` E11000 bubbles through Mongoose's instrumentation layer. Mongoose's OTel plugin sets the span's error status based on the thrown exception — it has no awareness that `withLock()`'s calling code will catch and handle E11000 as an expected condition. The span error is recorded before the catch block in the caller has a chance to suppress it.

### Secondary Finding: Missing `@awaitIndexesReady()` and OTel Context Break

On the first invocation of `LockCollection` in a deployment instance, `LockCollection.createLock()` is missing the `@BaseCollection.awaitIndexesReady()` decorator that all other `BaseCollection` methods have:

```ts
// lock.ts — createLock() has NO @awaitIndexesReady() decorator
async createLock(lockDocument: LockDocument): Promise<Lock> {
    this.validateData(lockDocument);
    const lock = new Lock(lockDocument);
    await lock.save({ session: this.session });  // fires without waiting for index init
    ...
}
```

Contrast with the base class:
```ts
// base.ts — all standard methods are decorated
@BaseCollection.awaitIndexesReady()
async insert(...) { ... }
```

This means on first use, the `LockCollection` constructor fires `_ensureIndexes()` as a fire-and-forget background promise while `createLock()` proceeds immediately. Mongoose's internal `ensureIndexes` pre-hook runs asynchronously, breaking the OTel async context chain — so the `mongodb.insert` driver span (s10) ends up parented to the root HTTP server span (s1) instead of appearing as a child of `mongoose.Lock.save` (s8). This distorts the trace tree, making the trace appear to show two concurrent inserts racing, when in reality they are the same single insert operation observed at two different instrumentation layers. **This context break does not cause the E11000** (which originates from a legitimately concurrent request holding the lock), but it does make the trace misleading.

## Fix

**No code changes are required to fix the E11000 error itself** — the locking mechanism is working exactly as designed and the request completed successfully.

### Recommended Enhancements (not fixes for a bug)

**1. Suppress expected E11000 errors from the OTel `mongoose.Lock.save` span** *(reduces monitoring noise)*

In `withLock()`, the `createLock()` call site can be wrapped in a way that prevents Mongoose's OTel instrumentation from recording E11000 as a span error. One approach is to catch the error before it escapes the active span, record it as a non-error event, and re-evaluate — or configure the OTel Mongoose plugin to exclude error-code 11000 from span error status. This would stop the error from appearing in error monitoring dashboards as a false alert.

**2. Add `@BaseCollection.awaitIndexesReady()` to `LockCollection.createLock()`** *(fixes OTel trace distortion on first use)*

```ts
// lock.ts
@BaseCollection.awaitIndexesReady()
async createLock(lockDocument: LockDocument): Promise<Lock> {
    this.validateData(lockDocument);
    const lock = new Lock(lockDocument);
    await lock.save({ session: this.session });
    return lock;
}
```

This ensures that on the first request to use the lock collection, index initialization completes before the save is attempted, maintaining the OTel async context chain and producing correct parent-child span relationships in traces.


---
