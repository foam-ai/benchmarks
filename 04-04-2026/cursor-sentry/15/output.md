## TL;DR
The AI agent's system prompt lacks the `otel_logs` table schema, causing the LLM to hallucinate a non-existent `Attributes` column (the real columns are `LogAttributes` and `ResourceAttributes`).

## What Broke and Why

The `BaseAgent` in `mewtwo/src/agents/base.agent.ts` is an AI research agent that investigates production errors by generating and executing ClickHouse SQL queries via the `queryOtel` tool (`mewtwo/src/agents/tools/query-otel.tool.ts`).

The **causality chain** is:

1. **System prompt provides an incomplete example**: The `buildSystemPrompt()` method (line 248) gives the LLM an example query selecting `Body, Timestamp, ServiceName, SeverityText` from `otel_logs`, but never documents the full table schema or available column names.

2. **Tool description is also schema-free**: The `queryOtel` tool's `sql` parameter description says only `"ClickHouse SQL query for otel_logs or otel_traces. Include time filter and LIMIT."` — no column names are provided.

3. **The LLM hallucinates a column name**: Without schema information, the AI agent guessed that `Attributes` is a valid column in `otel_logs`. This is a reasonable guess — OpenTelemetry data models do have "attributes" — but the ClickHouse OpenTelemetry exporter uses specific column names: `LogAttributes` (for log-level attributes), `ResourceAttributes` (for resource-level attributes), and `ScopeAttributes` (for scope-level attributes). There is no column called simply `Attributes`.

4. **ClickHouse rejects the query**: The generated query `SELECT Body, Timestamp, ServiceName, SeverityText, Attributes FROM otel_logs WHERE (Body LIKE '%no spac%') AND (Timestamp > (now() - toIntervalHour(24))) ORDER BY Timestamp DESC LIMIT 50` is sent to ClickHouse, which returns `Error: Unknown expression identifier 'Attributes'`.

5. **Error is caught and reported to Sentry**: The `queryOtel` tool's `catch` block (line 58-63) captures the exception via `Sentry.captureException(error)` and returns a JSON error string to the agent. While this doesn't crash the agent, it means the agent's first query fails, degrading its investigation quality.

Notably, the codebase already has a working reference for the correct schema: `mewtwo/src/services/exception-span-fetcher.service.ts` queries `otel_traces` and correctly uses `Events.Attributes` (the nested array column on the traces table). This confirms the column naming convention — attributes are always prefixed with their scope (Log, Resource, Scope, Span, Events).

## Fix

Update the system prompt in `mewtwo/src/agents/base.agent.ts` (`buildSystemPrompt()` method) to include the actual table schemas so the LLM generates valid queries:

```typescript
private buildSystemPrompt(): string {
    return `You are a research agent investigating production errors. You have access to production logs via ClickHouse.

Your core task is to investigate the root cause of the error and provide a detailed report. Do not focus on solutioning.

## Table Schemas

### otel_logs
| Column | Type |
|---|---|
| Timestamp | DateTime64 |
| TraceId | String |
| SpanId | String |
| SeverityText | LowCardinality(String) |
| SeverityNumber | Int32 |
| ServiceName | LowCardinality(String) |
| Body | String |
| ResourceAttributes | Map(LowCardinality(String), String) |
| LogAttributes | Map(LowCardinality(String), String) |

### otel_traces
| Column | Type |
|---|---|
| Timestamp | DateTime64 |
| TraceId | String |
| SpanId | String |
| ParentSpanId | String |
| SpanName | LowCardinality(String) |
| ServiceName | LowCardinality(String) |
| Duration | Int64 |
| StatusCode | LowCardinality(String) |
| StatusMessage | String |
| SpanAttributes | Map(LowCardinality(String), String) |
| ResourceAttributes | Map(LowCardinality(String), String) |
| Events.Timestamp | Array(DateTime64) |
| Events.Name | Array(LowCardinality(String)) |
| Events.Attributes | Array(Map(LowCardinality(String), String)) |

IMPORTANT: There is NO column called "Attributes" — use LogAttributes, ResourceAttributes, SpanAttributes, or Events.Attributes as appropriate.
To query map columns: LogAttributes['key.name'], ResourceAttributes['service.name'], etc.

Example first query:
SELECT Body, Timestamp, ServiceName, SeverityText, LogAttributes
FROM otel_logs 
WHERE Body LIKE '%${this.run.foamTelemetry?.exceptionMessage?.includes(':') ? this.run.foamTelemetry?.exceptionMessage?.split(':').pop()?.trim().slice(0, 30) : 'error'}%' 
AND Timestamp > now() - INTERVAL 24 HOUR 
ORDER BY Timestamp DESC 
LIMIT 50

...rest of prompt...`;
}
```

Additionally, update the tool description in `mewtwo/src/agents/tools/query-otel.tool.ts` to include schema hints:

```typescript
sql: z
    .string()
    .describe(
        'ClickHouse SQL query for otel_logs or otel_traces. Include time filter and LIMIT. ' +
        'otel_logs columns: Body, Timestamp, ServiceName, SeverityText, SeverityNumber, TraceId, SpanId, LogAttributes, ResourceAttributes. ' +
        'otel_traces columns: SpanName, Timestamp, ServiceName, TraceId, SpanId, ParentSpanId, Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes, Events.Timestamp, Events.Name, Events.Attributes. ' +
        'Use LogAttributes[\'key\'] or ResourceAttributes[\'key\'] to access map values. There is no column called just "Attributes".',
    ),
```

---
