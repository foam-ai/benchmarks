# RCA Analysis - Eval 8: E11000 Duplicate Key Error

## TL;DR
Concurrent webhook processing attempts to acquire a lock on the same resource simultaneously, causing duplicate key insertion on the lock collection's compound unique index before the first lock holder could release it.

## What Broke and Why

### Root Cause Chain

**Primary Cause:** Missing or ineffective lock cleanup during concurrent webhook processing

**Detailed Failure Mechanism:**

1. **Webhook Arrival**: Sentry webhook arrives for a specific customer (`68225b7c65937a6a6f391d1d`), type `webhook`, and resource ID `7202529779`

2. **Lock Acquisition Attempt #1**: First request enters `withLock()` function in `src/routers/sentry/webhook.ts`
   - Attempts to insert lock document: `{ customerId, type: 'webhook', resourceId: '7202529779' }`
   - Lock successfully created in MongoDB `lock` collection
   - Processing begins (calls `runSolverPipeline()`, queues job, etc.)

3. **Concurrent Request Collision**: Before the first lock expires or is released, a second webhook arrives with:
   - Same customer ID
   - Same type (`webhook`)
   - Same resource ID (`7202529779`)

4. **Lock Acquisition Attempt #2**: Second request enters the same `withLock()` function
   - Compound unique index check: `{ customerId_1_type_1_resourceId_1 }`
   - Duplicate key already exists from request #1
   - E11000 error thrown during `insertOne()` operation

### Why This Happens

**Causality Chain:**

- **Root Issue**: `withLock()` implementation either:
  1. Has no TTL (time-to-live) on lock documents → old locks persist indefinitely
  2. Has insufficient lock timeout duration → slow requests prevent concurrent cleanup
  3. Fails to release locks on error/completion → locks leak on partial failures
  4. Has a race condition in the lock check-then-insert pattern

- **Contributing Factor**: Sentry webhooks can fire multiple times for the same issue
  - Sentry may retry failed deliveries
  - Customer webhook settings may cause multiple deliveries
  - GitHub status change can trigger multiple Sentry events

- **No Fallback Handling**: The webhook router doesn't gracefully handle existing locks
  - Expects lock insertion to always succeed
  - No retry logic with exponential backoff
  - No queue-based deduplication before attempting lock

### Evidence

From the telemetry data:
- **Stack trace shows**: `InsertOneOperation.execute()` failed at MongoDB driver level
- **Error message confirms**: Duplicate key on index `customerId_1_type_1_resourceId_1`
- **Timing**: Error occurred during `Collection.insertOne()` for the lock document
- **Service**: Running at `/app/node_modules/mongodb/src/operations/insert.ts:88`

## Fix

### Immediate Solution (Priority 1)

**Implement proper lock lifecycle management** in `src/mongodb/services/lock.service.ts`:

1. **Add TTL index to lock collection**:
   ```javascript
   // Create index with automatic cleanup after 5 minutes
   db.lock.createIndex(
     { createdAt: 1 },
     { expireAfterSeconds: 300 }  // 5-minute TTL
   )
   ```

2. **Update lock.service.ts - withLock() function**:
   ```typescript
   export async function withLock<T>(
     lockKey: { customerId: string; type: string; resourceId: string },
     handler: () => Promise<T>
   ): Promise<T> {
     const maxWaitTime = 30_000; // 30 seconds
     const lockDocument = {
       ...lockKey,
       createdAt: new Date(),
       expiresAt: new Date(Date.now() + 5 * 60 * 1000) // 5-minute TTL
     };

     try {
       // Try to acquire lock with exponential backoff
       let attempts = 0;
       while (attempts < 5) {
         try {
           await db.collection('lock').insertOne(lockDocument);
           break; // Lock acquired
         } catch (error) {
           if (error.code === 11000) {
             // Duplicate key - check if existing lock is stale
             const existingLock = await db.collection('lock').findOne(lockKey);
             
             if (existingLock && existingLock.expiresAt < new Date()) {
               // Lock is stale, delete and retry
               await db.collection('lock').deleteOne(lockKey);
               await db.collection('lock').insertOne(lockDocument);
               break;
             }

             // Lock held by active request - wait and retry
             attempts++;
             await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempts)));
             
             if (attempts >= 5) {
               throw new Error(`Lock acquisition timeout after ${attempts} retries`);
             }
           } else {
             throw error;
           }
         }
       }

       try {
         // Execute the handler while holding lock
         return await handler();
       } finally {
         // Always release lock
         await db.collection('lock').deleteOne(lockKey);
       }
     } catch (error) {
       // Ensure lock cleanup even on error
       await db.collection('lock').deleteOne(lockKey).catch(() => {});
       throw error;
     }
   }
   ```

### Secondary Solution (Priority 2)

**Add deduplication at webhook ingestion** in `src/routers/sentry/webhook.ts`:

1. **Queue deduplication check** before `withLock()`:
   ```typescript
   // Check if this exact webhook is already processing
   const dedupeKey = `webhook:${customerId}:${resourceId}`;
   const existingJob = await issueSolverQueue.findJob(dedupeKey);
   
   if (existingJob) {
     // Already queued, return success to avoid Sentry retry
     return res.status(200).json({ queued: true, duplicate: true });
   }
   ```

2. **Implement circuit breaker** for rapid-fire webhook deliveries:
   ```typescript
   // Debounce rapid webhook deliveries from same source
   const lastDelivery = await redis.get(`webhook-last:${customerId}:${resourceId}`);
   if (lastDelivery) {
     const timeSinceLastDelivery = Date.now() - parseInt(lastDelivery);
     if (timeSinceLastDelivery < 5000) {
       // Too soon, queue for later processing
       return res.status(202).json({ queued: true, debounced: true });
     }
   }
   ```

### Tertiary Solution (Priority 3)

**Implement graceful degradation** in the webhook handler:

```typescript
export async function handleWebhookWithLock(req, res) {
  try {
    await withLock(lockKey, async () => {
      await runSolverPipeline(...);
    });
    res.status(200).json({ success: true });
  } catch (error) {
    if (error.code === 11000 || error.message.includes('duplicate key')) {
      // Lock contention - return 202 Accepted instead of 500
      // Sentry will retry and eventually succeed with backoff
      logger.warn('Webhook lock contention', { customerId, resourceId });
      res.status(202).json({ queued: true, lockWaitlist: true });
    } else {
      throw error; // Other errors should still fail loudly
    }
  }
}
```

---
