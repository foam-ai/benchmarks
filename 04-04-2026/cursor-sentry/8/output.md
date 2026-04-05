## TL;DR
The `withLock` retry loop's `instanceof MongoServerError` check fails to catch E11000 duplicate key errors, causing them to propagate as unhandled exceptions instead of being retried.

## What Broke and Why

The error occurs in the Sentry webhook handler (`src/routers/sentry/webhook.ts`) which wraps webhook processing in a distributed lock via `withLock()`. The lock mechanism (`src/mongodb/services/lock.service.ts`) uses a unique compound index on `(customerId, type, resourceId)` in the `lock` collection to ensure mutual exclusion. When two concurrent webhooks arrive for the same Sentry issue (customerId `68225b7c65937a6a6f391d1d`, resourceId `7202529779`), the second one gets an E11000 duplicate key error — which is expected and should be retried.

**The causality chain:**

1. Sentry fires a webhook for issue `7202529779` for customer `68225b7c65937a6a6f391d1d`.
2. The webhook handler calls `withLock(customerId, issueId, 'webhook', ...)` at line 169 of `webhook.ts`.
3. `withLock` (line 32, `lock.service.ts`) opens a MongoDB session via `connection.withSession()` and attempts to insert a lock document via `lockColl.createLock(lockDoc)`.
4. `createLock` (line 12, `lock.ts`) calls `new Lock(lockDocument)` using the **globally-registered** `Lock` model (from `getOrCreateModel` in `lock.schema.ts`) and calls `lock.save({ session })`.
5. The insert fails with `MongoServerError` code 11000 because another webhook for the same issue already holds the lock.
6. The catch block at line 67 checks: `error instanceof MongoServerError && error.code === 11000`.
7. **The `instanceof MongoServerError` check returns `false`**, causing the error to fall through to the `else` branch which re-throws it.
8. The error propagates through `withLock` → `connection.withSession` → the Express `catch(next)` handler → Sentry.

**Why `instanceof` fails:**

The `MongoServerError` class is imported from `'mongodb'` (line 6, `lock.service.ts`). However, `mongoose@^8.7.0` bundles its own `mongodb@^6.x` dependency. In the production Docker build, npm/yarn may resolve two distinct copies of the `mongodb` package — one at the top level (from the direct `"mongodb": "^6.9.0"` dependency in `package.json`) and one nested inside `node_modules/mongoose/node_modules/mongodb/`. When Mongoose's `save()` method throws a `MongoServerError` from its bundled copy, the `instanceof` check against the top-level `MongoServerError` fails because they are different class constructors from different module instances.

This is a well-known Node.js pitfall with `instanceof` checks across duplicate module installations. The error object has `error.name === 'MongoServerError'` and `error.code === 11000`, but `error instanceof MongoServerError` is `false`.

**Contributing factor — response timing:**

The HTTP response to Sentry is sent **inside** the `withLock` callback (lines 180-197), meaning the response is only sent after the lock is acquired AND processing completes. If lock acquisition stalls, Sentry's webhook delivery system may time out and retry, creating additional concurrent lock contention and amplifying this error.

## Fix

### Fix 1: Use duck-type error detection instead of `instanceof` (primary fix)

In `src/mongodb/services/lock.service.ts`, replace the `instanceof` check with a robust duck-type check on the error code:

```typescript
// Before (line 67):
if (error instanceof MongoServerError && error.code === 11000) {

// After:
if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: number }).code === 11000
) {
```

This catches E11000 errors regardless of which `MongoServerError` class instance the error belongs to. The `MongoServerError` import can be removed.

### Fix 2: Use `this.model` in `createLock` instead of globally-imported `Lock`

In `src/mongodb/collections/lock.ts`, `createLock` uses the globally-registered `Lock` model (`new Lock(lockDocument)`) instead of `this.model` from the `BaseCollection`. This inconsistency means the lock document is saved via a model that may not share the same connection as the session:

```typescript
// Before:
async createLock(lockDocument: LockDocument): Promise<Lock> {
    this.validateData(lockDocument);
    const lock = new Lock(lockDocument);
    await lock.save({ session: this.session });
    ...
}

// After:
async createLock(lockDocument: LockDocument): Promise<Lock> {
    this.validateData(lockDocument);
    const model = this.getModel();
    const lock = new model(lockDocument);
    await lock.save({ session: this.session });
    ...
}
```

### Fix 3: Acknowledge webhook before lock acquisition

Move the HTTP 202 response before the `withLock` call so Sentry doesn't retry while the lock is contended. Process the webhook asynchronously:

```typescript
// Send 202 immediately to acknowledge receipt
res.sendStatus(202);

// Process asynchronously — errors will still be caught by the global error handler
await withLock(customerId, issueId, 'webhook', 30 * 60 * 1000, async () => {
    // ... processing logic (remove res.sendStatus/res.json calls inside)
});
```

This reduces the thundering-herd effect where Sentry retries trigger additional lock contention.

---
