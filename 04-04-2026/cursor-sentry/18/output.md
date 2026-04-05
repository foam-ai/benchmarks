## TL;DR
ClickHouse queries from the exception polling worker lack `max_memory_usage` limits, allowing unbounded memory consumption that exhausts the server's 28.80 GiB memory cap when fetching large batches of nested `Events` data.

## What Broke and Why

The error `(total) memory limit exceeded: would use 28.74 GiB ... maximum: 28.80 GiB. OvercommitTracker decision: Query was selected to stop` is a **ClickHouse server-side memory limit** error. ClickHouse's OvercommitTracker killed the query because it would push total server RSS past the configured 28.80 GiB ceiling.

**Root cause chain:**

1. **No per-query memory limits on exception polling queries.** The `fetchExceptionSpans()` function in `mewtwo/src/services/exception-span-fetcher.service.ts` (lines 110-133) executes ClickHouse queries with **zero** `clickhouse_settings` — no `max_execution_time` and critically, no `max_memory_usage`. Every other ClickHouse query path in the codebase (`execute-query.ts`, `query-otel.tool.ts`, `query-otel-upgraded.tool.ts`) at least sets `max_execution_time: 30`, but none set `max_memory_usage`.

2. **Heavy query payload.** The `buildExceptionSpanQuery()` function selects the `Events` column from `otel_traces` — a nested `Array(Tuple(Timestamp, Name, Array(Map(String, String))))` structure. Each row can contain multiple exception events with full attribute maps including stacktraces. With a `LIMIT 5000` (set in the worker at line 274), ClickHouse must materialize thousands of rows of deeply nested data in memory before returning results.

3. **Concurrent execution amplifies the problem.** The exception polling worker runs with `concurrency: 5` (line 399 of `exception-polling.worker.ts`), meaning up to 5 of these unbounded queries can hit ClickHouse simultaneously. Five queries each consuming several GiB of memory easily exhausts the 28.80 GiB server limit.

4. **No `max_memory_usage` anywhere in the codebase.** This is a systemic gap — none of the four ClickHouse query execution paths set `max_memory_usage` in their `clickhouse_settings`. The exception polling path is the worst offender because it also lacks `max_execution_time` and fetches the most data.

## Fix

### Immediate fix: Add `max_memory_usage` to the exception polling query

In `mewtwo/src/services/exception-span-fetcher.service.ts`, add ClickHouse settings to the query call:

```typescript
// Execute query
const result = await client.query({
    query,
    format: 'JSONEachRow',
    clickhouse_settings: {
        max_execution_time: 30,
        max_memory_usage: 4_000_000_000, // 4 GiB per query — safe with concurrency 5 under 28.8 GiB server limit
    },
});
```

### Broader fix: Add `max_memory_usage` to all ClickHouse query paths

Apply the same `max_memory_usage` setting to:
- `mewtwo/src/clients/clickhouse/execute-query.ts` (line 24) — add `max_memory_usage: 4_000_000_000` alongside `max_execution_time`
- `mewtwo/src/agents/tools/query-otel.tool.ts` (line 65) — add `max_memory_usage: 4_000_000_000`
- `mewtwo/src/agents/tools/query-otel-upgraded.tool.ts` (line 278) — add `max_memory_usage: 4_000_000_000`

### Optional: Reduce batch size

Reduce the exception polling LIMIT from 5000 to 1000 in `mewtwo/src/workers/exception-polling.worker.ts` line 274. This reduces peak memory per query while still making progress through the backlog over multiple polling cycles:

```typescript
const spans = await fetchExceptionSpans({
    serviceName: serviceId,
    sinceTimestamp,
    limit: 1000, // Reduced from 5000 to prevent memory pressure
});
```

---
