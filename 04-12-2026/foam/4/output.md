[Foam Trace ID: 29501ee8fd9760d022d8d3ec37df89d1] ## TL;DR

The `SimpletonAgent` issued `DESCRIBE otel_logs` to ClickHouse via the `queryOtel` tool. A blanket `LIMIT 500` auto-injection in `query-otel.tool.ts` transformed the query to `DESCRIBE otel_logs LIMIT 500`, and the ClickHouse Node client then appended `FORMAT JSONEachRow`, producing the fully invalid query `DESCRIBE otel_logs LIMIT 500 FORMAT JSONEachRow`. ClickHouse rejected it because `DESCRIBE` accepts neither a `LIMIT` nor a `FORMAT` clause. The fix is to skip `LIMIT` injection for DDL/metadata statements like `DESCRIBE`, `SHOW`, `EXPLAIN`, etc.

## What Broke and Why

### The Causal Chain

**1. Agent issues a metadata query**

A BullMQ job (`job #1558`, queue `issue-solver-queue`) triggered the `SimpletonAgent` (Claude Sonnet) to investigate an issue. The agent's first action was to call its `queryOtel` tool to inspect the telemetry schema, emitting the query:
```
DESCRIBE otel_logs
```
This is confirmed by the log at `2026-01-18 18:15:57.143` from `src/agents/tools/query-otel.tool.ts:44`:
```
[SimpletonAgent] queryOtel { sqlPreview: 'DESCRIBE otel_logs', ... }
```

**2. Unconditional `LIMIT 500` injection on ALL queries**

In `/repo/mewtwo/src/agents/tools/query-otel.tool.ts`, the `executeQuery` function blindly appends `LIMIT 500` to any query that does not already contain a `LIMIT` keyword:

```typescript
async function executeQuery(sql: string, agentName: string) {
    let query = sql.trim().replace(/;$/, '');
    if (!/\bLIMIT\b/i.test(query)) {
        query += ' LIMIT 500';   // ← appended without checking statement type
    }
    const client = await connectClickhouse();
    const result = await client.query({
        query,
        format: 'JSONEachRow',   // ← SDK will append FORMAT JSONEachRow to query string
        clickhouse_settings: { max_execution_time: 30 },
    });
```

`DESCRIBE otel_logs` contains no `LIMIT` keyword → the query becomes `DESCRIBE otel_logs LIMIT 500`.

**3. ClickHouse Node client appends `FORMAT JSONEachRow`**

The `@clickhouse/client` Node SDK automatically appends `\nFORMAT JSONEachRow` to the query string before sending it to the ClickHouse HTTP endpoint (triggered by the `format: 'JSONEachRow'` option). The final query sent over the wire is:

```
DESCRIBE otel_logs LIMIT 500
FORMAT JSONEachRow
```

**4. ClickHouse rejects the query with a syntax error**

`DESCRIBE` (equivalent to `DESCRIBE TABLE`) is a DDL/metadata statement. It does not accept a `LIMIT` clause. ClickHouse's parser considers the statement complete after `DESCRIBE otel_logs`, then encounters the unexpected tokens `LIMIT 500 FORMAT JSONEachRow`. The token `500` lands at character position 26 (the string `DESCRIBE otel_logs LIMIT ` is 25 characters, 1-indexed), which exactly matches the reported error:

> `Syntax error: failed at position 26 (500) (line 1, col 26): 500 \nFORMAT JSONEachRow. Expected end of query.`

The `(500)` in the error is the **literal SQL token `500`** — not an HTTP status code. The HTTP response body is this raw ClickHouse error text, which `parseError` in `packages/client-common/src/error/error.ts:31` reads verbatim from the response body and wraps into a `ClickHouseError`.

**5. Error is surfaced and handled**

The exception propagates up via `ClientRequest.onResponse` → `parseError` and is recorded as an exception span (`spanId=7ea65f1036115efb`). The agent recovers and falls back to a valid query (`SELECT * FROM otel_logs LIMIT 1`), so the parent job ultimately completes — but the error is nonetheless emitted to Sentry.

### Complete Causal Chain Summary

```
Agent calls queryOtel('DESCRIBE otel_logs')
  → executeQuery: no LIMIT keyword found
  → LIMIT 500 injected unconditionally
  → query = 'DESCRIBE otel_logs LIMIT 500'
  → ClickHouse client appends FORMAT JSONEachRow
  → final query = 'DESCRIBE otel_logs LIMIT 500\nFORMAT JSONEachRow'
  → ClickHouse rejects: DESCRIBE does not support LIMIT
  → Syntax error at position 26 (token: 500)
  → parseError surfaces raw error body as ClickHouseError
  → exception recorded in span 7ea65f1036115efb
```

## Fix

**Guard the `LIMIT` injection against DDL and metadata statements** in `/repo/mewtwo/src/agents/tools/query-otel.tool.ts`:

```typescript
async function executeQuery(sql: string, agentName: string) {
    let query = sql.trim().replace(/;$/, '');

    const isDDLOrMetadata = /^\s*(DESCRIBE|SHOW|EXISTS|EXPLAIN|CREATE|DROP|ALTER|TRUNCATE|RENAME|ATTACH|DETACH|OPTIMIZE|CHECK)\b/i.test(query);

    if (!isDDLOrMetadata && !/\bLIMIT\b/i.test(query)) {
        query += ' LIMIT 500';
    }

    const client = await connectClickhouse();
    const result = await client.query({
        query,
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: 30 },
    });
```

**Why this fix breaks the causal chain:** The `LIMIT 500` injection is the single step that transforms the valid `DESCRIBE otel_logs` into the invalid `DESCRIBE otel_logs LIMIT 500`. With the DDL guard in place, `DESCRIBE otel_logs` is sent as-is; the ClickHouse SDK appends `FORMAT JSONEachRow` producing `DESCRIBE otel_logs\nFORMAT JSONEachRow`, which is also invalid for `DESCRIBE` — so a secondary consideration is whether `FORMAT JSONEachRow` itself is appropriate for `DESCRIBE` queries. If not, the format should also be conditionally applied (e.g., `format: isDDLOrMetadata ? 'JSONEachRow' : 'JSONEachRow'` — ClickHouse does actually support `FORMAT JSONEachRow` for `DESCRIBE TABLE`, so only the `LIMIT` clause is the blocker). The primary fix (skipping `LIMIT` injection for DDL statements) is sufficient to resolve this exact error.

---
