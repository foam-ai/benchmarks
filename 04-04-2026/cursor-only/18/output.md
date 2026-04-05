## TL;DR
ClickHouse queries against `otel_traces` lack a per-query `max_memory_usage` setting, so a broad scan with `ORDER BY … LIMIT` on the large `Events.Attributes` column materializes the entire matching result set in memory, exceeding the server's 28.80 GiB limit.

## What Broke and Why
The error is a ClickHouse server-side OOM: a query attempted to allocate memory that would push total server RSS to 28.74 GiB against a 28.80 GiB hard cap. ClickHouse's `OvercommitTracker` killed the query. The telemetry hint `avg_value_size_hint = 880.080` confirms the rows contain large values — consistent with the `Events.Attributes` column, which is an `Array(Map(LowCardinality(String), String))` storing full exception stacktraces, messages, and types.

The causality chain:

1. **No per-query memory cap anywhere in the codebase.** A grep for `max_memory_usage` across all ClickHouse query paths returns zero results. The `connect.ts` client sets only `request_timeout: 120_000`. The `executeQuery` function and agent tools (`query-otel.tool.ts`, `query-otel-upgraded.tool.ts`) set `clickhouse_settings: { max_execution_time: 30 }` but never `max_memory_usage`. The `fetchExceptionSpans` function sets no `clickhouse_settings` at all.

2. **The `fetchExceptionSpans` query is the most expensive path.** It runs every 30 seconds via the exception polling scheduler and builds this query (from `exception-span-fetcher.service.ts:87-102`):
   ```sql
   SELECT SpanId, ParentSpanId, Timestamp, SpanName, ServiceName,
          TraceId, StatusCode, Duration, Events
   FROM otel_traces
   WHERE ServiceName = '...'
     AND Timestamp > '...'
     AND arrayExists(x -> mapContains(x, 'exception.type'), Events.Attributes)
   ORDER BY Timestamp ASC
   LIMIT 5000
   ```

3. **`ORDER BY … LIMIT` forces a full materialization.** ClickHouse must scan all rows matching the `WHERE` clause, load the `Events.Attributes` column into memory for the `arrayExists` filter evaluation, sort the entire result set by `Timestamp`, and only then apply `LIMIT 5000`. If a service has millions of matching spans (e.g., due to a large time gap in `sinceTimestamp` or initial bootstrap with no timestamp), this materializes gigabytes of `Events` data.

4. **The `Events` column is disproportionately large.** The `otel_traces` table schema shows `Events.Attributes` is `Array(Map(LowCardinality(String), String))`. Exception spans store `exception.type`, `exception.message`, and `exception.stacktrace` in these maps — stacktraces alone can be kilobytes per span. Selecting `Events` for thousands or millions of rows explodes memory usage.

5. **Agent tool queries are also unbounded.** The `query-otel-upgraded.tool.ts` defaults to `LIMIT 500` (line 271) despite the description claiming 100, and neither tool sets `max_memory_usage`. An LLM-generated query filtering on `Events.Attributes` with `arrayExists` triggers the same OOM pattern.

6. **The table's sort key doesn't help the filter.** The table is `ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))`. While `ServiceName` and `Timestamp` filters use the sort key efficiently, the `arrayExists` on `Events.Attributes` must still be evaluated on every candidate row, requiring that column to be loaded into memory.

## Fix

**1. Add `max_memory_usage` to all ClickHouse query execution paths** — this is the immediate, critical fix that prevents any single query from OOMing the server:

In `mewtwo/src/clients/clickhouse/execute-query.ts`:
```typescript
clickhouse_settings: {
  max_execution_time: maxExecutionTime,
  max_memory_usage: 4_000_000_000, // 4 GiB per-query cap
},
```

In `mewtwo/src/services/exception-span-fetcher.service.ts` (`fetchExceptionSpans`):
```typescript
const result = await client.query({
  query,
  format: 'JSONEachRow',
  clickhouse_settings: {
    max_execution_time: 60,
    max_memory_usage: 4_000_000_000, // 4 GiB per-query cap
  },
});
```

In `mewtwo/src/agents/tools/query-otel.tool.ts` and `query-otel-upgraded.tool.ts`:
```typescript
clickhouse_settings: {
  max_execution_time: 30,
  max_memory_usage: 4_000_000_000, // 4 GiB per-query cap
},
```

**2. Restructure `fetchExceptionSpans` to avoid materializing `Events` during sort** — use a two-phase query that first identifies matching SpanIds (lightweight), then fetches full data only for those:

```typescript
return `
  SELECT SpanId, ParentSpanId, Timestamp, SpanName, ServiceName,
         TraceId, StatusCode, Duration, Events
  FROM otel_traces
  WHERE SpanId IN (
    SELECT SpanId
    FROM otel_traces
    ${whereClause}
    ORDER BY Timestamp ASC
    ${limitClause}
  )
  ORDER BY Timestamp ASC
`.trim();
```

The inner subquery sorts and limits on just `SpanId` (lightweight, no `Events` materialization), then the outer query fetches `Events` only for the limited set.

**3. Fix the inconsistent LIMIT in `query-otel-upgraded.tool.ts`** — line 271 defaults to `LIMIT 500` while the description says 100. Change to `LIMIT 100` for consistency with the documented contract and to reduce memory pressure.
