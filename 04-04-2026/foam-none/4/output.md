[Foam Trace ID: c3690a168e7de29353f0d03d91c90698] ## TL;DR

The `query-otel.tool.ts` tool blindly appends `LIMIT 500` to any ClickHouse query that doesn't already contain the word "LIMIT", without checking whether the SQL statement type supports the `LIMIT` clause. When the AI agent issued `DESCRIBE otel_logs`, this produced the invalid query `DESCRIBE otel_logs LIMIT 500`, which ClickHouse rejected with a syntax error. The fix is to only append `LIMIT 500` to `SELECT`/`WITH` queries.

## What Broke and Why

The `mewtwo` service runs an AI agent (`SimpletonAgent`) that can query ClickHouse via the `queryOtel` tool defined in `src/agents/tools/query-otel.tool.ts`. During issue-solver job #1558 (runId `88dcd44e-d59d-439f-8f80-61161899cbb7`), the agent's first tool call was a `DESCRIBE otel_logs` query to discover the table schema.

The query construction pipeline in `query-otel.tool.ts` has three stages:

1. **AI agent generates SQL** — `DESCRIBE otel_logs` (logged as `sqlPreview` at line 44, timestamp `18:15:57.143`)
2. **`query-otel.tool.ts` appends LIMIT** — Between lines 44–55, after logging the preview, the code checks if the query text contains the word "LIMIT" and, if not, appends ` LIMIT 500`. Since `DESCRIBE otel_logs` contains no "LIMIT", the query becomes `DESCRIBE otel_logs LIMIT 500`.
3. **ClickHouse client appends FORMAT** — The `@clickhouse/client` library automatically appends `\nFORMAT JSONEachRow`, producing the final query: `DESCRIBE otel_logs LIMIT 500\nFORMAT JSONEachRow`.

ClickHouse's `DESCRIBE` statement does not support the `LIMIT` clause. The server's SQL parser successfully consumed `DESCRIBE otel_logs`, then encountered the unexpected token `LIMIT` followed by `500` at character position 26. It returned an HTTP 500 response with:

```
Syntax error: failed at position 26 (500) (line 1, col 26): 500 
FORMAT JSONEachRow. Expected end of query.
```

The character-position math confirms this precisely: `"DESCRIBE otel_logs LIMIT "` is exactly 25 characters, placing the literal `500` at position 26 — exactly as reported.

The confusing double appearance of `500` in the error message is a coincidence: `(500)` is the HTTP status code ClickHouse returns for query errors (standard behavior, inserted by the `parseError` function at `error.ts:31`), while `500\nFORMAT JSONEachRow` is the remaining unparsed query text starting from the LIMIT value.

The bug is that the LIMIT-appending logic only checks whether `LIMIT` already appears in the query text — it does **not** check whether the statement type supports `LIMIT`. All four queries in this trace session confirm the pattern:

| Query | Has LIMIT in sqlPreview? | LIMIT 500 appended? | Result |
|-------|-------------------------|---------------------|--------|
| `DESCRIBE otel_logs` | No | **Yes** → syntax error | FAIL |
| `SELECT * FROM otel_logs LIMIT 1` | Yes | No | SUCCESS |
| `SELECT ... ORDER BY Timestamp DESC LIMIT 10` | Yes | No | SUCCESS |
| `SELECT ... ORDER BY Timestamp ASC LIMIT 20` | Yes | No | SUCCESS |

The error was handled gracefully — the agent retried with a `SELECT` query and continued processing. However, the bug will recur every time the AI agent generates a `DESCRIBE`, `SHOW`, `EXPLAIN`, or any other non-SELECT statement that lacks an existing "LIMIT" substring.

**Alternative hypothesis considered:** The `500` could represent an HTTP status code leaking into the query string. This was eliminated — the stack trace shows the error originates from ClickHouse's HTTP response (`node_base_connection.ts:553` → `parseError` at `error.ts:31`), and the character-position math conclusively proves the `500` is the hardcoded LIMIT value, not an HTTP status code.

## Fix

In `src/agents/tools/query-otel.tool.ts`, modify the LIMIT-appending logic (between lines 44–55) to only append `LIMIT 500` to statements that support the `LIMIT` clause (`SELECT` and `WITH` queries):

```typescript
const trimmedUpper = sql.trim().toUpperCase();
const supportsLimit = trimmedUpper.startsWith('SELECT') || trimmedUpper.startsWith('WITH');
if (supportsLimit && !trimmedUpper.includes('LIMIT')) {
    sql += ' LIMIT 500';
}
```

**Why this breaks the causal chain:** The root cause is that `LIMIT 500` is appended to `DESCRIBE` (and similar non-SELECT statements). With the statement-type check, `DESCRIBE otel_logs` would be sent as-is (with only the client's `FORMAT JSONEachRow` appended, which ClickHouse also doesn't support for DESCRIBE — but this is handled separately by the ClickHouse client's `format` option). If `FORMAT` appending is also problematic for non-SELECT queries, consider using the client's `query()` method with `format: 'JSONEachRow'` only for SELECT queries, and a raw command method for metadata queries.

An alternative comprehensive fix is to use ClickHouse's `max_result_rows` query setting instead of SQL-level LIMIT appending, which works transparently across all statement types:

```typescript
const result = await client.query({
    query: sql,
    clickhouse_settings: { max_result_rows: '500' },
});
```

---
