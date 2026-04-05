## TL;DR

An LLM agent (`MultiHypothesisResearchAgent`) autonomously generated a pathological ClickHouse SQL query — a `FULL OUTER JOIN` between `otel_logs` (147K rows) and `otel_traces` (133K rows) on `DATE(Timestamp)` — producing a ~10 billion row intermediate cross-product that consumed 28.74 GiB and exceeded the 28.80 GiB server memory limit. The root cause is that `query-otel-upgraded.tool.ts` has no per-query `max_memory_usage` ClickHouse setting and no guardrails (either code-level or in its LLM validation prompt) to reject or rewrite expensive cross-join patterns before execution.

## What Broke and Why

### The Triggering Event

During a Braintrust automated evaluation run (`eval.task.2026-01-30-deep-research-multi-hypotheses/foam-empty-solution-uploaded-to-s3`), the `MultiHypothesisResearchAgent` — an LLM-powered SRE research agent using Claude Haiku 4.5 — generated a "final verification" SQL query to check temporal correlation between two error types:

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

### Why the Query Was Catastrophically Expensive

The `FULL OUTER JOIN ON DATE(t1.Timestamp) = DATE(t2.Timestamp)` is effectively a **cross-join within each date bucket**. With data spanning only 2 distinct dates:

- **2026-01-29**: 58,587 logs × 62,468 traces = **3.66 billion** intermediate rows
- **2026-01-30**: 89,094 logs × 71,306 traces = **6.35 billion** intermediate rows
- **Total**: ~**10 billion intermediate rows**

The `WHERE` clause LIKE filters and `LIMIT 10` cannot help — ClickHouse must materialize the full JOIN before applying post-join predicates and aggregation. The query consumed 28.74 GiB in 7.25 seconds before ClickHouse's OvercommitTracker killed it:

> `(total) memory limit exceeded: would use 28.74 GiB (attempt to allocate chunk of 16.10 MiB bytes), current RSS: 28.81 GiB, maximum: 28.80 GiB. OvercommitTracker decision: Query was selected to stop`

### Why No Guardrail Caught This

The query was executed through `query-otel-upgraded.tool.ts` (`createQueryOtelUpgradedTool`), registered as `queryOtel` in the agent's tool configuration at `/repo/mewtwo/src/agents/deep-research-multi-hypotheses-upgraded-otel-tool/index.ts`:

```typescript
const tools = {
    queryOtel: createQueryOtelUpgradedTool(this.toolCtx),
    // ...
};
```

**Three layers of defense all failed:**

1. **No per-query memory limit**: The `executeQuery` function only sets `max_execution_time: 30` but no `max_memory_usage`:
   ```typescript
   clickhouse_settings: { max_execution_time: maxExecutionTime }
   ```
   This means a single query can consume the entire 28.80 GiB ClickHouse server budget before the 30-second timeout fires.

2. **LLM validation is syntax-only, not cost-aware**: The `validateAndFixQueryWithLLM()` function (lines 48–146) instructs the validation LLM to check column names, Map syntax, and ClickHouse dialect — but contains **zero guidance** about query cost, JOINs, or memory:
   ```
   Validate and fix the following SQL query for the ClickHouse database.
   Check if it follows ClickHouse syntax, uses correct column names, and follows best practices.
   ```
   The FULL OUTER JOIN is syntactically valid, so validation passes.

3. **No code-level JOIN pattern detection**: There is no regex or AST-based check to reject `FULL OUTER JOIN`, `CROSS JOIN`, or JOIN-on-date-bucket patterns before execution.

### Additional Defect Found (Separate Issue)

The upgraded tool also has a latent `LIMIT 500` bug where the comment says 100 but the code says 500:
```typescript
} else {
    // No limit provided, add default of 100
    query += ' LIMIT 500';  // ← BUG: should be LIMIT 100
}
```
This did **not** contribute to this specific OOM (the query already had `LIMIT 10`), but is a real defect that should be fixed.

### Alternative Hypothesis Considered

**Was the LIMIT 500 bug the root cause?** No — verified that the failing query had an explicit `LIMIT 10`, so the LIMIT enforcement was a no-op. Furthermore, for queries with `GROUP BY` + aggregation over a FULL OUTER JOIN, the LIMIT is applied *after* the entire intermediate result is materialized, making any LIMIT value irrelevant to memory consumption.

## Fix

**Primary fix**: Add per-query `max_memory_usage` and external spillover settings to `executeQuery()` in both `query-otel.tool.ts` and `query-otel-upgraded.tool.ts`:

```typescript
clickhouse_settings: {
    max_execution_time: maxExecutionTime,
    max_memory_usage: '4000000000',                  // 4 GiB per query
    max_bytes_before_external_group_by: '2000000000', // spill GROUP BY to disk at 2 GiB
    max_bytes_before_external_sort: '2000000000',     // spill ORDER BY to disk at 2 GiB
}
```

This breaks the causal chain at the memory allocation step: instead of allowing a single query to consume the entire 28.80 GiB server budget, it caps any individual query at 4 GiB and enables disk spillover for aggregations. The pathological FULL OUTER JOIN would fail fast with a clear per-query memory error rather than crashing the entire ClickHouse server.

**Secondary fix**: Add explicit JOIN cost guidance to the LLM validation prompt in `query-otel-upgraded.tool.ts` and to the tool description:

```
- NEVER use FULL OUTER JOIN, CROSS JOIN, or JOIN ON DATE(...) between otel_logs and otel_traces — these create billion-row cross-products. Instead, run separate queries on each table and correlate results in application code.
- Always include tight Timestamp filters (e.g., within 1 hour) in WHERE clauses.
```

**Tertiary fix**: Correct the LIMIT 500 bug in `query-otel-upgraded.tool.ts` line 270 from `LIMIT 500` to `LIMIT 100` to match the documented behavior and the original tool.

---