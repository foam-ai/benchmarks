## TL;DR
LLM agent generated a ClickHouse query using non-existent column `Attributes` instead of `LogAttributes` on `otel_logs`, because the system prompt and tool description didn't specify the table schema.

## What Broke and Why

The BaseAgent (an LLM-powered RCA investigator in `mewtwo/src/agents/base.agent.ts`) uses an AI model to construct ClickHouse SQL queries at runtime via the `queryOtel` tool. When investigating a "Docker mkdir no space" error (trace `acacf6df3ca6fc48f31c48c6cbaf8808`), the LLM generated this query:

```sql
SELECT Body, Timestamp, ServiceName, SeverityText, Attributes
FROM otel_logs
WHERE (Body LIKE '%no spac%')
AND (Timestamp > (now() - toIntervalHour(24)))
ORDER BY Timestamp DESC LIMIT 50
```

This fails with: `Unknown expression identifier 'Attributes'`

**Root cause**: The `otel_logs` table has a column named `LogAttributes` (type `Map(LowCardinality(String), String)`), **not** `Attributes`. The LLM hallucinated the column name because:

1. **The system prompt** (`base.agent.ts` line 249-276) only provides one example query with `Body, Timestamp, ServiceName, SeverityText` — it never lists the full table schemas or column names.
2. **The tool description** (`query-otel.tool.ts` line 47) says `"Query OpenTelemetry logs or traces from ClickHouse (otel_logs, otel_traces tables)"` but doesn't enumerate available columns.
3. **No query validation or normalization** exists in `executeQuery()` — the raw LLM-generated SQL is passed directly to ClickHouse.

The error was caught by the try/catch in the tool's `execute` function (line 56-63), which returned the error as JSON to the LLM. However, this wasted an agent step and the agent had to recover.

## Fix

Two complementary fixes applied to `mewtwo/src/agents/`:

**1. Add table schemas to the system prompt** (`base.agent.ts`):
Added a "ClickHouse Table Schemas" section listing all column names for both `otel_logs` and `otel_traces`, with an explicit warning that `otel_logs` does NOT have an `Attributes` column.

**2. Add column name normalization to the tool** (`tools/query-otel.tool.ts`):
Added a `normalizeColumnNames()` function that auto-corrects `Attributes` → `LogAttributes` when the query targets `otel_logs`. This is a defensive layer so even if the LLM still hallucinates the wrong name, the query succeeds.

**3. Add schema to tool description** (`tools/query-otel.tool.ts`):
Updated the tool's `description` field to include the column names for both tables, giving the LLM schema context at the tool-call level in addition to the system prompt.

---
