[Foam Trace ID: 7be92a78c9e6ea8f4df3c1ff2df86753] ## TL;DR

The `queryOtel` tool executes AI-generated SQL against ClickHouse without per-query memory limits (`max_memory_usage`). The `MultiHypothesisResearchAgent` generated an unbounded temporal correlation query that consumed ~28.74 GiB of server memory, hitting the server-level 28.80 GiB limit and being killed by ClickHouse's OvercommitTracker. The fix is to inject a per-query `max_memory_usage` SETTING in the `queryOtel` tool's ClickHouse query execution path.

## What Broke and Why

The `MultiHypothesisResearchAgent`, running inside the `braintrust` CLI (v0.3.8) evaluation service, invoked the `queryOtel` tool with an AI-generated SQL query for temporal correlation analysis:

```
-- Final verification: Check temporal correlation between solution generation failure
```

The telemetry shows this query referenced multiple large text columns from both the spans and logs OTel tables — confirmed by the column auto-correction log:

```
[ClickHouse] Auto-corrected column names { corrections: ['timestamp → Timestamp', 'timeStamp → Timestamp', 'statusmessage → StatusMessage', 'statusMessage → StatusMessage', 'body → Body'] }
```

The `StatusMessage` column belongs to the spans/traces table while `Body` belongs to the logs table, indicating a **cross-table JOIN** between OTel spans and logs. These are large String columns with an average value size of ~880 bytes per row (`avg_value_size_hint = 880.080`), meaning even moderate row counts produce massive memory consumption.

The `queryOtel` tool's query execution pipeline applies only **column name auto-correction** before sending the SQL as an HTTP POST to ClickHouse's HTTP interface. **No per-query safety settings are injected** — no `max_memory_usage`, no `max_execution_time`, no `max_rows_to_read`, and no enforced `LIMIT` clause.

This is proven by the error message prefix:

```
(total) memory limit exceeded: would use 28.74 GiB ... maximum: 28.80 GiB
```

ClickHouse uses distinct prefixes: `(total)` for server-level `max_server_memory_usage` and `(for query)` for per-query `max_memory_usage`. The `(total)` prefix conclusively proves **no per-query memory limit was set**. Had one existed (e.g., 10 GiB), ClickHouse would have killed the query with `(for query) memory limit exceeded` well before it threatened server stability.

The 28.80 GiB server limit is ClickHouse's auto-calculated default: `32 GiB container memory × 0.9 ratio = 28.80 GiB`. The query ran for ~7.25 seconds, consuming nearly the entire server memory allocation before the OvercommitTracker selected it for termination. The host has 251.7 GiB total RAM but ClickHouse runs in a 32 GiB container.

The causal chain:
1. AI agent generates unbounded temporal correlation query joining spans + logs tables with large String columns
2. `queryOtel` tool preprocesses only column names — no safety settings injected
3. SQL posted to ClickHouse HTTP interface without `SETTINGS max_memory_usage=...`
4. ClickHouse processes query, materializing ~28.74 GiB of intermediate results from large String columns across both tables
5. Server-level `max_server_memory_usage` (28.80 GiB) exceeded → OvercommitTracker kills query

**Alternative hypothesis considered:** Could concurrent queries have caused combined memory pressure? The telemetry shows `(total) memory limit` which is a server-wide limit, and a single query consumed 28.74 GiB of 28.80 GiB available. This single query was sufficient to exhaust the entire server memory — concurrent load is not required to explain the failure. The root cause remains the absence of per-query memory limits.

## Fix

Add per-query ClickHouse safety settings in the `queryOtel` tool's query execution code. When constructing the HTTP POST to ClickHouse, append `SETTINGS` to the SQL or pass them as URL query parameters:

```sql
-- Append to every AI-generated query before execution:
SETTINGS max_memory_usage = 10000000000,       -- 10 GiB per-query limit
         max_execution_time = 30,               -- 30 second timeout
         max_rows_to_read = 50000000,           -- 50M row scan limit
         max_bytes_before_external_group_by = 5000000000  -- 5 GiB before disk spill
```

Alternatively, these can be passed as URL parameters to the ClickHouse HTTP interface:

```
POST /?max_memory_usage=10000000000&max_execution_time=30&max_rows_to_read=50000000
```

This fix is applied in the `braintrust` package's ClickHouse client module — the same code path that already performs column name auto-correction (logged as `[ClickHouse] Auto-corrected column names`). The existing preprocessing layer should be extended to also inject these safety settings.

**Why this breaks the causal chain:** With `max_memory_usage = 10 GiB` set per-query, ClickHouse would kill the offending query with `(for query) memory limit exceeded` at 10 GiB — well before it can consume the server's 28.80 GiB total allocation. The query fails fast with a clear error, the server remains stable for other queries, and the AI agent receives a meaningful error it can use to reformulate a more constrained query (e.g., adding LIMIT, narrowing time ranges, or selecting fewer columns).

Additionally, the `queryOtel` tool description/system prompt for the AI agent should instruct it to always include `LIMIT` clauses and avoid broad cross-table JOINs — but this is a defense-in-depth measure, not the primary fix, since AI agents may not reliably follow such instructions.

---
