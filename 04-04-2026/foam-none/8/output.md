[Foam Trace ID: e0b7e84e778b7132f9617edcf623fcf1] ## TL;DR

The E11000 duplicate key error is **expected behavior**, not a bug. The application uses MongoDB's unique compound index on the `lock` collection as a distributed locking primitive — a successful `insertOne` means the lock is acquired, and an E11000 duplicate key error means another process already holds the lock. The error is caught at `lock.service.ts:69`, the operation retries after ~1 second, successfully acquires the lock, and the parent webhook request completes normally.

## What Broke and Why

Nothing actually broke. The application implements a distributed lock using a MongoDB unique compound index `customerId_1_type_1_resourceId_1` on the `lock` collection. The lock acquisition pattern works as follows:

1. A `POST /sentry/webhook` request for an `event_alert` (action: `triggered`) arrived at `23:20:32.397` for customer `68225b7c65937a6a6f391d1d` and resource `7202529779`.

2. The webhook handler attempted to acquire a lock by inserting a document into the `lock` collection via `Lock.save()` (`lock.service.ts:58`):
   ```json
   {
     "_id": "696ebc406dc026a72c9b6b35",
     "expiredAt": "2026-01-19T23:50:32.481Z",
     "customerId": "68225b7c65937a6a6f391d1d",
     "type": "webhook",
     "resourceId": "7202529779"
   }
   ```

3. The insert failed with `E11000 duplicate key error collection: foam_db.lock index: customerId_1_type_1_resourceId_1` because another concurrent webhook request for the same customer and resource already held the lock (a document with the same `{customerId, type, resourceId}` tuple already existed).

4. The error was **caught** at `lock.service.ts:69` and logged at **DEBUG** level: `"Lock already exists for customerId: 68225b7c65937a6a6f391d1d and resourceId: 7202529779"`. This is intentional — E11000 on this index is the signal for "lock already held."

5. After a ~1 second backoff, the lock was retried at `23:20:33.503` (the competing request had released its lock via `Lock.deleteOne` in the interim). The retry succeeded at `23:20:33.527` — logged as `"Acquired lock"` at `lock.service.ts:62`.

6. The webhook was processed (in this case, the action was ignored per `webhook.ts:194`: `"Received and ignored webhook action"`), the lock was explicitly released via `Lock.findOne` → `Lock.deleteOne`, and the parent `POST /sentry/webhook` span completed successfully in 1205ms.

The error surfaces in telemetry because OpenTelemetry's MongoDB driver auto-instrumentation records the `MongoServerError` on the span regardless of whether the application catches it. The span shows status `Error`, but this is an instrumentation artifact — the application-level handling is correct.

**Alternative hypothesis considered:** Could the reuse of the same `_id` and `expiredAt` across retries cause issues? No — the first insert failed (no document with that `_id` was persisted), and both retry attempts use `InsertOneOperation.execute`, confirming Mongoose treats the document as new on each attempt. The `expiredAt` not being refreshed is a minor design observation (longer retry sequences would yield a shorter effective TTL) but did not cause any issue here.

## Fix

**No fix required.** The E11000 duplicate key error is the intended mechanism for detecting lock contention in this distributed locking pattern. The error is correctly caught, retried with backoff, and the overall operation succeeds.

**Optional enhancements (non-fixes):**
- **Suppress span error status for expected E11000:** Consider adding span status override logic or a custom OpenTelemetry span processor that marks E11000 errors on the `lock` collection as non-errors, reducing noise in error monitoring dashboards.
- **Refresh `expiredAt` on retry:** Regenerate the `expiredAt` timestamp on each retry attempt so that locks acquired after many retries still have the full 30-minute TTL.
- **Add a retry limit:** If not already present (could not confirm from telemetry alone), add a maximum retry count or timeout to prevent indefinite spinning if a lock is held for an extended period (e.g., up to 30 minutes if a process crashes without releasing).

---
