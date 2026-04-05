## TL;DR
`LIMIT 500` is unconditionally appended to all queries including `DESCRIBE`, which doesn't support LIMIT, causing a ClickHouse syntax error.

## What Broke and Why

The `SimpletonAgent` issued a `DESCRIBE otel_logs` query via the `queryOtel` tool to discover the table schema. In `mewtwo/src/agents/tools/query-otel.tool.ts`, the `executeQuery` function blindly appends `LIMIT 500` to any query that doesn't already contain the word "LIMIT":

```typescript
let query = sql.trim().replace(/;$/, '');
if (!/\bLIMIT\b/i.test(query)) {
    query += ' LIMIT 500';
}
```

This transformed `DESCRIBE otel_logs` into `DESCRIBE otel_logs LIMIT 500`. The ClickHouse Node.js client then further appended `FORMAT JSONEachRow`, producing the final query:

```
DESCRIBE otel_logs LIMIT 500\nFORMAT JSONEachRow
```

ClickHouse's `DESCRIBE` statement does not support a `LIMIT` clause. The parser successfully consumed `DESCRIBE otel_logs`, then encountered `LIMIT 500 FORMAT JSONEachRow` where it expected end-of-query. This produced the error:

```
Syntax error: failed at position 26 (500) (line 1, col 26): 500 FORMAT JSONEachRow. Expected end of query.
```

Position 26 is exactly where `500` begins in `DESCRIBE otel_logs LIMIT 500` (25 characters precede it).

**Telemetry evidence:**
- TraceId: `22f571223cda9f7e49fa70afbeac1d97`
- The error span (`7ea65f1036115efb`) is a child of the `process issue-solver-queue` span (`fd87c116a2948067`)
- Log at `2026-01-18 18:15:57.143` shows `sqlPreview: 'DESCRIBE otel_logs'` — the first query the SimpletonAgent attempted
- Log at `2026-01-18 18:15:57.243` shows the resulting ClickHouse syntax error
- The agent recovered by retrying with `SELECT * FROM otel_logs LIMIT 1` which succeeded

## Fix

**File:** `mewtwo/src/agents/tools/query-otel.tool.ts` (line 16-18)

Only append `LIMIT 500` to `SELECT` queries, not to utility statements like `DESCRIBE`, `SHOW`, `EXPLAIN`, etc.:

```typescript
const isSelectQuery = /^\s*SELECT\b/i.test(query);
if (isSelectQuery && !/\bLIMIT\b/i.test(query)) {
    query += ' LIMIT 500';
}
```

This fix has been applied in the worktree at `/Users/perla/code/all-the-things-cursor-qo/eval-4/`.

---
