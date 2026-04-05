## TL;DR
AI agent issued a `FULL OUTER JOIN` between `otel_logs` and `otel_traces` on `DATE(Timestamp)`, creating a massive cartesian product that exceeded ClickHouse's 28.8 GiB memory limit — the `queryOtel` tool has no `max_memory_usage` guard.

## What Broke and Why

**The error chain:**

1. The **eval service** was running the `deep-research-multi-hypotheses` experiment investigating issue `5b44b816-8c8d-4850-9860-007c73f2f038` ("empty solution uploaded to S3").

2. The AI agent (Claude 3.7 Sonnet, via `ai.streamText`) was using the `queryOtel` tool to investigate the root cause. During its investigation, it issued this SQL query:

```sql
SELECT 
    DATE(t1.Timestamp) as error_date,
    COUNT(DISTINCT CASE WHEN t1.Body LIKE '%Solution result is empty for runId%' THEN 1 END) as backend_empty_solution_errors,
    COUNT(DISTINCT CASE WHEN t2.StatusMessage LIKE '%has an empty solution string%' THEN 1 END) as frontend_empty_solution_errors
FROM otel_logs t1
FULL OUTER JOIN otel_traces t2 ON DATE(t1.Timestamp) = DATE(t2.Timestamp)
WHERE (t1.Body LIKE '%Solution result is empty for runId%' OR t2.StatusMessage LIKE '%has an empty solution string%')
    AND t1.Timestamp >= '2026-01-20 00:00:00'
GROUP BY error_date
ORDER BY error_date DESC
LIMIT 10
```

3. **The critical problem**: This `FULL OUTER JOIN` joins `otel_logs` to `otel_traces` on `DATE(Timestamp)` — essentially a **date-granularity cartesian product**. With both tables containing millions of rows, joining on just the date produces an enormous intermediate result set. ClickHouse must materialize the full join in memory, and the error message confirms: **28.74 GiB was needed while the limit was 28.80 GiB** (with RSS already at 28.81 GiB).

4. The ClickHouse `OvercommitTracker` killed the query: `avg_value_size_hint = 880.08 bytes`, reading from column `Body` in `otel_logs` stored on S3 disk, from mark 528 with 8192 rows per batch.

**Why the guardrails failed:**

- **`max_execution_time: 30`** was set in `query-otel.tool.ts` (line 65), but **no `max_memory_usage`** setting was configured. The query could consume unlimited memory before timing out.
- The **LIMIT 10** on the outer query is irrelevant — ClickHouse must fully materialize the `FULL OUTER JOIN` before applying GROUP BY and LIMIT.
- The tool caps result row LIMIT at 100 and adds `max_execution_time: 30`, but there is **no validation of query complexity** (no checks for JOINs between large tables, no memory bounds).
- The `query-otel-upgraded.tool.ts` version has LLM-based query validation, but it focuses on syntax/schema correctness rather than query cost/safety.

**Timeline:**
- `00:12:45` — Eval task started (`foam-empty-solution-uploaded-to-s3`)
- `00:12:53` — AI agent began investigation via `ai.streamText`
- `00:23:38` — Agent issued the fatal `FULL OUTER JOIN` query via `queryOtel` tool
- `00:23:45` — ClickHouse OOM: `(total) memory limit exceeded: would use 28.74 GiB`

## Fix

### Immediate fix: Add `max_memory_usage` to ClickHouse query settings

In `mewtwo/src/agents/tools/query-otel.tool.ts` (line 62-66) and `query-otel-upgraded.tool.ts` (line 274-279), add a per-query memory limit:

```typescript
const result = await client.query({
    query,
    format: 'JSONEachRow',
    clickhouse_settings: {
        max_execution_time: 30,
        max_memory_usage: 4_000_000_000, // 4 GiB per query — prevents any single agent query from OOMing the server
    },
});
```

This returns a clear "memory limit exceeded" error to the agent instead of crashing the entire ClickHouse server for all concurrent queries.

### Secondary fix: Block dangerous query patterns

Add a pre-execution check in `executeQuery()` to reject or warn on `FULL OUTER JOIN` and `CROSS JOIN` patterns between the two large telemetry tables:

```typescript
function detectDangerousJoins(query: string): string | null {
    const upperQuery = query.toUpperCase();
    if (
        (upperQuery.includes('FULL OUTER JOIN') || upperQuery.includes('CROSS JOIN')) &&
        upperQuery.includes('OTEL_LOGS') &&
        upperQuery.includes('OTEL_TRACES')
    ) {
        return 'FULL OUTER JOIN / CROSS JOIN between otel_logs and otel_traces is prohibited — it creates a cartesian product. Use specific TraceId or SpanId joins instead.';
    }
    return null;
}
```

### Tertiary fix: Add query cost guidance to tool description

Update the `queryOtel` tool description to explicitly warn agents against expensive join patterns:

```
IMPORTANT: Never use FULL OUTER JOIN or CROSS JOIN between otel_logs and otel_traces.
These tables contain millions of rows and joining on date/time will cause memory exhaustion.
Always join on specific identifiers (TraceId, SpanId).
```

---
