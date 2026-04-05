## TL;DR
The BaseAgent's system prompt doesn't specify the ClickHouse `otel_logs` table schema, so the LLM hallucinated a nonexistent `Attributes` column — the real columns are `LogAttributes`, `ResourceAttributes`, and `ScopeAttributes`.

## What Broke and Why
The `BaseAgent` in `mewtwo/src/agents/base.agent.ts` gives an LLM a `queryOtel` tool that executes arbitrary ClickHouse SQL. The system prompt (line 248–276) provides an example query using only `Body, Timestamp, ServiceName, SeverityText` but never documents the full table schema. When the LLM tried to query log attributes for the investigation, it guessed the column name `Attributes` — a reasonable but incorrect inference.

The actual `otel_logs` table (created by the OpenTelemetry Collector's ClickHouse exporter, configured in `mewtwo/otel-collector-config.yaml`) uses the standard OTEL schema with columns: `Timestamp`, `TraceId`, `SpanId`, `SeverityText`, `SeverityNumber`, `ServiceName`, `Body`, `ResourceAttributes`, `ScopeAttributes`, and `LogAttributes`. There is no plain `Attributes` column.

The causality chain:
1. `BaseAgent.buildSystemPrompt()` provides an example query but omits the table schema and available column names.
2. The LLM agent generated: `SELECT Body, Timestamp, ServiceName, SeverityText, Attributes FROM otel_logs WHERE (Body LIKE '%no spac%') AND (Timestamp > (now() - toIntervalHour(24))) ORDER BY Timestamp DESC LIMIT 50`.
3. `createQueryOtelTool` in `query-otel.tool.ts` passes user-generated SQL directly to ClickHouse with no validation or column name checking.
4. ClickHouse rejected the query with: `Unknown expression identifier 'Attributes' in scope`.
5. The error was caught (line 58–63 of `query-otel.tool.ts`), captured by Sentry/Foam, and returned as a JSON error string to the agent — but the Sentry capture is what generated the telemetry event we're investigating.

## Fix
Add the `otel_logs` and `otel_traces` table schemas to the system prompt in `BaseAgent.buildSystemPrompt()` (`mewtwo/src/agents/base.agent.ts`, line 248). This tells the LLM exactly which columns exist so it won't hallucinate column names:

```typescript
private buildSystemPrompt(): string {
    return `You are a research agent investigating production errors. You have access to production logs via ClickHouse.

Your core task is to investigate the root cause of the error and provide a detailed report. Do not focus on solutioning.

## ClickHouse Table Schemas

### otel_logs
Columns: Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes

### otel_traces
Columns: Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, SpanAttributes, Duration, StatusCode, StatusMessage, Events.Timestamp, Events.Name, Events.Attributes

IMPORTANT: There is NO column called "Attributes" on either table. Use LogAttributes (logs), SpanAttributes (traces), or ResourceAttributes as appropriate. These are Map(String, String) types — query them with mapContains() or bracket notation like LogAttributes['key'].

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

This fix addresses the root cause (missing schema documentation) rather than the symptom (one bad query). The LLM will now have the correct column names available in its context and use `LogAttributes` instead of the nonexistent `Attributes`.
