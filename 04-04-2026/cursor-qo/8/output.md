## TL;DR
Distributed lock's "insert-and-catch-E11000" pattern generates expected duplicate key errors that OTel auto-instrumentation captures and forwards to Sentry via the Foam SDK bridge, creating false-positive error alerts during normal concurrent webhook processing.

## What Broke and Why

### The Error
A `MongoServerError: E11000 duplicate key error` on the `foam_db.lock` collection, index `customerId_1_type_1_resourceId_1`, when two concurrent Sentry webhook requests for the same issue (`resourceId: 7202529779`, customer `68225b7c65937a6a6f391d1d`) tried to acquire the same distributed lock.

### The Mechanism
The `withLock()` function in `src/mongodb/services/lock.service.ts` uses a deliberate "optimistic insert" pattern for distributed locking:

1. Create a new `Lock` document and call `lock.save()` (which does a MongoDB `insert`)
2. If the unique index `(customerId, type, resourceId)` rejects the insert with E11000, catch the error, sleep 1 second, and retry
3. Repeat until the lock is acquired or timeout (30 minutes)

This pattern works correctly at the **application level** — the trace confirms:
- `23:20:32.481` — First `mongoose.Lock.save` → **E11000 error** (caught and retried)
- `23:20:33.503` — Second `mongoose.Lock.save` → **success** (lock acquired)
- `23:20:33.548` — `mongoose.Lock.deleteOne` → lock released after work completes
- HTTP response: **202 Accepted** (request succeeded)

### Why It Surfaced as a Reported Error

The Foam SDK initialization in `src/instrument.ts` bridges OTel to Sentry:
```typescript
foam.init({
    serviceName: 'mono',
    sentryIntegrationEnabled: true,  // ← OTel span errors → Sentry
    ...
});
```

The OTel mongoose/MongoDB auto-instrumentation captures exceptions at the **driver level** — *before* the application's catch block in `withLock()` can handle them. The `mongoose.Lock.save` span is marked `StatusCode: Error` with the E11000 as an exception event. The Foam SDK then forwards this span exception to Sentry, creating a false-positive error report.

### The Commit Context
Commit `05e8314` ("Where there is a sentry capture there should be a foam capture") added `foam.captureException(err)` calls alongside existing `Sentry.captureException` throughout the codebase. While this specific E11000 doesn't reach the global error handler (it's caught by `withLock`), the commit represents the broader deployment of the Foam SDK with `sentryIntegrationEnabled: true`, which routes ALL OTel span errors to monitoring — including expected lock contention errors.

## Fix

### Immediate Fix: Replace insert-and-catch with atomic upsert in `LockCollection`

**File: `src/mongodb/collections/lock.ts`**

Add a new `tryAcquireLock` method that uses `findOneAndUpdate` with `upsert: true`, which atomically creates the lock or returns `null` if one already exists — without throwing E11000:

```typescript
async tryAcquireLock(lockDocument: LockDocument): Promise<Lock | null> {
    this.validateData(lockDocument);
    const result = await Lock.findOneAndUpdate(
        {
            customerId: lockDocument.customerId,
            type: lockDocument.type,
            resourceId: lockDocument.resourceId,
        },
        {
            $setOnInsert: {
                _id: lockDocument._id,
                expiredAt: lockDocument.expiredAt,
                customerId: lockDocument.customerId,
                type: lockDocument.type,
                resourceId: lockDocument.resourceId,
            },
        },
        {
            upsert: true,
            new: true,
            session: this.session,
        },
    );

    if (result._id.equals(lockDocument._id)) {
        return result;
    }
    return null;
}
```

**File: `src/mongodb/services/lock.service.ts`**

Update `withLock` to use the new non-throwing method:

```typescript
// Replace the inner try-catch block (lines 56-82) with:
lock = await lockColl.tryAcquireLock(lockDoc);
if (lock) {
    log().debug(
        `Acquired lock for customerId: ${customerId} and resourceId: ${resourceId} with type: ${type}`,
    );
    break;
}
log().debug(
    `Lock already exists for customerId: ${customerId} and resourceId: ${resourceId}`,
);
await sleep(SLEEP_TIME);
timeWaiting = Date.now() - startTime;
```

### Why This Fix Works
- `findOneAndUpdate` with `upsert: true` on the unique index fields is **atomic** — no E11000 is thrown
- By checking if the returned document's `_id` matches the intended `_id`, we know whether we created the lock or found an existing one
- No exceptions are generated during normal lock contention, so OTel records no span errors
- The retry-with-sleep behavior is preserved for when the lock is already held

---
