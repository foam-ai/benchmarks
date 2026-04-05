## TL;DR

The E11000 duplicate key error on `foam_db.lock` is **not a bug** — it is the expected, handled contention signal of a distributed locking mechanism. A concurrent Sentry webhook for the same issue ID held the lock when this request attempted to acquire it. The code caught the error, retried after 1 second, succeeded, and the HTTP request completed with 202 ACCEPTED.

## What Broke and Why

Nothing broke. The system worked exactly as designed.

The `POST /sentry/webhook` endpoint uses an insert-based distributed lock (`withLock()` in `lock.service.ts`) to prevent concurrent processing of webhooks for the same Sentry issue. The lock is implemented as a MongoDB document with a unique compound index on `{customerId, type, resourceId}`:

```typescript
// lock.schema.ts
LockSchema.index({ customerId: 1, type: 1, resourceId: 1 }, { unique: true });
```

When a second request attempts to insert a lock document with the same key tuple, MongoDB rejects it with E11000 — and `withLock()` treats this as an expected "lock held" signal:

```typescript
catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
        log().debug(`Lock already exists for customerId: ${customerId} and resourceId: ${resourceId}`);
        await sleep(SLEEP_TIME); // 1 second
        timeWaiting = Date.now() - startTime;
        // loop continues — retry
    } else {
        throw error;
    }
}
```

The telemetry confirms the full sequence:

1. **23:20:31.255** — Trace `38007ecb...` (a Sentry `issue.created` webhook) acquired the lock for `{customerId: 68225b7c..., type: "webhook", resourceId: "7202529779"}`.
2. **23:20:32.481** — The focus trace `664faea0...` (a Sentry `event_alert` webhook for the same issue) attempted to acquire the same lock → E11000 duplicate key error (this is the observed error).
3. **23:20:32.502** — The code caught the E11000, logged `"Lock already exists..."` at DEBUG level, and entered a 1-second sleep.
4. **23:20:32.672** — Trace `38007ecb...` released the lock via `deleteLock()` in its `finally` block.
5. **23:20:33.503** — The focus trace retried the lock insert → **succeeded**.
6. **23:20:33.527** — The webhook was processed (and ignored, as `event_alert` doesn't require action). Lock was released. HTTP 202 ACCEPTED returned.

The OTel span `9e6fe3d22ac9d6f1` recorded `StatusCode: Error` because the underlying `lock.save()` threw an exception at the MongoDB driver level. However, the enclosing application code (`withLock()`) explicitly catches and handles this exception — it never propagated to the HTTP response or caused any user-facing failure.

**Alternative hypothesis considered:** Stale/orphaned locks causing the contention. This was ruled out: the competing lock was actively held by a concurrent trace (`38007ecb...`) that acquired it just 1.2 seconds prior and released it normally via the `finally` block at 23:20:32.672. The TTL index on `expiredAt` serves as a safety net for process crashes but was not needed here.

## Fix

**No fix required.** The E11000 error is the intentional mechanism by which the distributed lock signals contention to concurrent callers. The retry logic worked correctly, and the request completed successfully.

**Optional enhancement (not a fix):** The OTel span records this as an error because the MongoDB driver throws and OTel auto-instrumentation captures the exception. To reduce alert noise, the team could either:
- Add a span event or attribute (e.g., `lock.contention: true`) when the E11000 is caught, to distinguish expected contention from real failures in observability dashboards.
- Configure alerting to exclude E11000 errors on the `lock` collection from error-rate metrics, since they are a normal operational signal.

---