## TL;DR

The `queryOtel` tool in `mewtwo/src/agents/tools/query-otel.tool.ts` unconditionally appends `LIMIT 500` to any SQL query that doesn't already contain `LIMIT`, but `DESCRIBE` statements don't support `LIMIT` clauses in ClickHouse. When a `SimpletonAgent` issued `DESCRIBE otel_logs`, the tool mutated it into `DESCRIBE otel_logs LIMIT 500`, which ClickHouse rejected with a syntax error. The fix is to guard the `LIMIT 500` append to only apply to `SELECT` queries.

## What Broke and Why

**The triggering event:** At `2026-01-18 18:15:57.143`, a `SimpletonAgent` (run `88dcd44e-d59d-439f-8f80-61161899cbb7`) called the `queryOtel` tool with the SQL string `DESCRIBE otel_logs` — a perfectly valid ClickHouse metadata statement to inspect the columns of a table.

**The faulty transformation:** In `mewtwo/src/agents/tools/query-otel.tool.ts`, the `executeQuery` function applies a row-limit guard intended to prevent runaway `SELECT` queries from returning too many rows:

```typescript
async function executeQuery(sql: string, agentName: string) {
    let query = sql.trim().replace(/;$/, '');
    if (!/\bLIMIT\b/i.test(query)) {
        query += ' LIMIT 500';   // ← applied to ALL query types, not just SELECT
    }
    const client = await connectClickhouse();
    const result = await client.query({
        query,
        format: 'JSONEachRow',   // ← @clickhouse/client appends " FORMAT JSONEachRow" to the query string
        clickhouse_settings: { max_execution_time: 30 },
    });
}
```

Because `DESCRIBE otel_logs` contains no `LIMIT` keyword, the regex `/\bLIMIT\b/i` does not match, and ` LIMIT 500` is blindly appended, producing:

```sql
DESCRIBE otel_logs LIMIT 500
```

The `@clickhouse/client` library then automatically appends ` FORMAT JSONEachRow` (because `format: 'JSONEachRow'` is set in the query options), resulting in the final string sent over the wire:

```sql
DESCRIBE otel_logs LIMIT 500 FORMAT JSONEachRow
```

**Why ClickHouse rejects it:** `DESCRIBE` is a metadata command, not a `SELECT` statement. It does not accept a `LIMIT` clause. ClickHouse's parser fails at **position 26** (1-indexed), which is precisely where `500` begins:

```
DESCRIBE otel_logs LIMIT 500 FORMAT JSONEachRow
^                        ^
position 1               position 26 = '5' of '500'
```

This matches the error exactly:
> `Syntax error: failed at position 26 (500) (line 1, col 26): 500 FORMAT JSONEachRow. Expected end of query.`

**Scope:** The other two production call sites that use `format: 'JSONEachRow'` — `exception-span-fetcher.service.ts` (which only ever produces `SELECT` statements via `buildExceptionSpanQuery`) and integration tests — are not affected. Only `query-otel.tool.ts` is vulnerable because it accepts arbitrary SQL strings from the LLM agent, including non-`SELECT` DDL/metadata commands.

**Recovery:** The agent recovered gracefully; subsequent `SELECT` queries (e.g., `SELECT * FROM otel_logs LIMIT 1` at `18:15:59.018`) succeeded normally.

## Fix

Restrict the `LIMIT 500` auto-append to `SELECT` queries only. A one-line guard eliminates the problem:

```typescript
// Before (buggy): appends LIMIT to ALL query types
if (!/\bLIMIT\b/i.test(query)) {
    query += ' LIMIT 500';
}

// After (fixed): only appends LIMIT to SELECT statements
if (/^\s*SELECT\b/i.test(query) && !/\bLIMIT\b/i.test(query)) {
    query += ' LIMIT 500';
}
```

**Why this fix breaks the causal chain:** With the additional `SELECT` guard, `DESCRIBE otel_logs` will pass through `executeQuery` unmodified (no `LIMIT 500` appended). The ClickHouse client will still append `FORMAT JSONEachRow`, producing `DESCRIBE otel_logs FORMAT JSONEachRow` — which ClickHouse also does not support. A more complete fix should also suppress the `format` option for non-`SELECT` statements:

```typescript
const isSelect = /^\s*SELECT\b/i.test(query);

if (isSelect && !/\bLIMIT\b/i.test(query)) {
    query += ' LIMIT 500';
}

const result = await client.query({
    query,
    ...(isSelect ? { format: 'JSONEachRow' } : {}),
    clickhouse_settings: { max_execution_time: 30 },
});
```

This ensures that `DESCRIBE`, `SHOW`, `EXPLAIN`, and other non-`SELECT` statements are sent to ClickHouse unmodified and without a forced `FORMAT` clause, which is the correct behavior. The introduced bug — the `500` literal appearing in a position the parser expects to be the end of the query — would no longer be possible.

---