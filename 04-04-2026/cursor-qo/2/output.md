## TL;DR
Redis ran out of memory when executing SET commands with 90-day cache TTLs for large dashboard row objects, triggering OOM errors in Redis Lua script execution at line 26.

## What Broke and Why

**The Failure Mechanism:**
When commit `c2509f47` was deployed, the system was using a Redis caching layer that stores large dashboard data structures with extended TTLs. The problem occurs in the `/dashboard/:runId` endpoint in `src/pages/dashboard.ts`:

1. **Large Cache Values**: The `dashboardRow` object (lines 341-350) contains:
   - Full snippet data with multiple sections
   - Timeline events
   - Sentry issue details
   - Root cause analysis data
   - This gets JSON.stringify'd and stored in Redis

2. **Extended TTL**: Cache key `solve-page-${runId}-${run?.updatedAt.getTime()}` is stored with:
   - TTL: `60 * 60 * 24 * 90` = 7,776,000 seconds (90 days)
   - This means each dashboardRow persists in Redis for 3 months
   - Cache keys are constructed with `run.updatedAt.getTime()`, so the same runId with different timestamps creates separate cache entries
   - Over time, this creates accumulated bloat

3. **Memory Pressure**: When Redis reaches its configured `maxmemory` threshold:
   - New SET commands cannot allocate memory for the value
   - Redis's eviction policy may not be aggressive enough to free space immediately
   - The SET operation fails with "OOM command not allowed when used memory > 'maxmemory'"

4. **Script Error Location**: The error occurs "on @user_script:26" because:
   - ioredis (the Node.js Redis client) may use internal Lua scripts for atomic operations
   - When the SET command executes within Redis's scripting engine, line 26 of that internal script triggers the OOM error
   - This is Redis's internal error handling within the Lua script processing

**The Causality Chain:**
```
Cache feature added (commit de3a5c8c)
  ↓
Large dashboardRow objects stored with 90-day TTL (commit de3a5c8c)
  ↓
Multiple cache keys created per runId due to updatedAt.getTime() in key
  ↓
Redis memory fills up over time with persistent cache entries
  ↓
New SET operations exceed Redis maxmemory limit
  ↓
Redis refuses to allocate memory, errors in SET command's Lua script
  ↓
OOM error thrown from redis-parser (line 26 of internal script)
```

## Fix

**Immediate Fix - Reduce TTL:**
Change line 333 in `src/pages/dashboard.ts`:

```typescript
// OLD
const TTLNinetyDays = 60 * 60 * 24 * 90;

// NEW
const TTLNinetyDays = 60 * 60 * 24 * 7;  // 7 days instead of 90
```

**Alternative Fix - Reduce Cached Object Size:**
Implement selective field caching for dashboardRow:

```typescript
// Only cache essential fields, not the entire object
const cacheableData = {
    title: dashboardRow.title,
    body: dashboardRow.body,
    shortId: dashboardRow.shortId,
    state: dashboardRow.state,
    // Exclude: snippets, linkedIssues, full timeline data
};
await redis.set(cacheKey, JSON.stringify(cacheableData), 'EX', TTLNinetyDays);
```

**Recommended Fix - Both:**
1. Reduce TTL from 90 days to 7 days to prevent long-term memory accumulation
2. Use cache key WITHOUT `run?.updatedAt.getTime()` to reuse cache for the same runId:
```typescript
// OLD: Creates new cache entry for each updatedAt change
const cacheKey = `solve-page-${runId}-${run?.updatedAt.getTime()}`;

// NEW: Reuses cache for same runId, auto-invalidates on TTL
const cacheKey = `solve-page-${runId}`;
```

**Root Cause Mitigation:**
- Monitor Redis memory usage in production
- Set Redis `maxmemory-policy` to `allkeys-lru` or `volatile-lru` for automatic eviction
- Consider reducing cache TTL across other endpoints:
  - `src/routers/stats.ts`: TTLOneDay (1 day) - acceptable
  - `src/pages/dashboard.ts`: Multiple TTLs including TTLNinetyDays and TTLFifteenMinutes - review all

---
