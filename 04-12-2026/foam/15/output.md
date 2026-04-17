[Foam Trace ID: 633a8160c9495eff589921e571cbdbc0] ## TL;DR

An AI agent (`BaseAgent` in `mewtwo`) queried ClickHouse using the column name `Attributes` in a `SELECT` against the `otel_logs` table. That column does not exist — the correct column name is `LogAttributes`. The agent guessed the wrong name because neither the `queryOtel` tool definition nor the system prompt ever documents the `otel_logs` schema. The fix is to add explicit column schema documentation to the tool definition and/or system prompt so the agent uses the correct column name on the first attempt.

---

## What Broke and Why

### The Error

During an automated issue-solver run (job 1500, `runId=3d73ce27-d4fc-4d61-afe9-8aae95ce838b`, `customerId=674e5380f251f603c5ef1847`), the `BaseAgent` attempted to query ClickHouse for production logs related to a "no space" disk error. At `2026-01-11 21:56:26.370`, it executed:

```sql
SELECT Body, Timestamp, ServiceName, SeverityText, Attributes
FROM otel_logs
WHERE (Body LIKE '%no spac%')
  AND (Timestamp > (now() - toIntervalHour(24)))
ORDER BY Timestamp DESC
LIMIT 50
```

ClickHouse rejected this with:
> `Unknown expression identifier 'Attributes' in scope SELECT Body, Timestamp, ServiceName, SeverityText, Attributes FROM otel_logs …`

### Why the Wrong Column Name Was Used

The `otel_logs` table has **no column named `Attributes`**. The correct column for log-level key-value attributes is `LogAttributes` (`Map(LowCardinality(String), String)`). The full table schema is:

```
CustomerId, Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber,
ServiceName, ServiceId, Body, ResourceSchemaUrl, ResourceAttributes,
ScopeName, ScopeVersion, ScopeSchemaUrl, ScopeAttributes, LogAttributes
```

The AI agent guessed `Attributes` from general OpenTelemetry naming conventions baked into its training data. It did so because **neither the tool definition nor the system prompt provides any schema guidance**:

1. **`/repo/mewtwo/src/agents/tools/query-otel.tool.ts`** — the `queryOtel` tool description reads only:
   ```typescript
   description: `Query OpenTelemetry logs or traces from ClickHouse (otel_logs, otel_traces tables). Always add a LIMIT to the query.`
   ```
   The Zod `sql` parameter description adds only: `'ClickHouse SQL query for otel_logs or otel_traces. Include time filter and LIMIT.'`
   **Zero column names or types are documented anywhere in the tool definition.**

2. **`/repo/mewtwo/src/agents/base.agent.ts` `buildSystemPrompt()`** — the example query in the system prompt exposes only four column names:
   ```sql
   SELECT Body, Timestamp, ServiceName, SeverityText
   FROM otel_logs
   WHERE Body LIKE '%<error snippet>%' ...
   ```
   `LogAttributes` is **never mentioned** anywhere in the system prompt. The agent is given no indication that attributes are stored under `LogAttributes` rather than the generic `Attributes` name used in some OTel collector schemas.

### The Agent's Self-Correction

The telemetry shows the agent recovered automatically: at `21:56:27.624` the log entry reads:
> `[BaseAgent] queryOtel intent='Find full error details for no space error' SQL preview with LogAttributes column`

The retry with `LogAttributes` succeeded. However, this wasted a full agent turn — an expensive LLM round-trip — and contributed to the overall run instability. The entire job ultimately failed at `21:58:35` with `No output generated. Check the stream for errors.` after exhausting its retry/nudge budget (nudged 2 of 3 times).

### Alternative Hypothesis Considered

**Could the schema have changed** (i.e., a column renamed from `Attributes` to `LogAttributes`)? There is no evidence of a recent DDL migration; `LogAttributes` is the standard ClickHouse OpenTelemetry exporter column name. The simpler, fully supported explanation is that the agent never had correct schema information — a schema change hypothesis would require evidence of a prior `Attributes` column that does not exist in any of the findings.

---

## Fix

### Root-Cause Fix: Document the `otel_logs` Schema in the Tool Definition

Add explicit column schema documentation to the `sql` parameter's `.describe()` call in **`/repo/mewtwo/src/agents/tools/query-otel.tool.ts`**:

```typescript
const schema = z.object({
    intent: z.string().describe('What you are looking for'),
    sql: z
        .string()
        .describe(
            `ClickHouse SQL query for otel_logs or otel_traces. Include a time filter and LIMIT.

otel_logs columns:
  Timestamp, ServiceName, ServiceId, Body, SeverityText, SeverityNumber,
  TraceId, SpanId, TraceFlags, CustomerId,
  LogAttributes Map(LowCardinality(String), String),   -- log-level key/value attributes
  ResourceAttributes Map(LowCardinality(String), String),
  ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeSchemaUrl,
  ScopeAttributes Map(LowCardinality(String), String)

otel_traces columns: TraceId, SpanId, ParentSpanId, SpanName, ServiceName,
  Duration, StatusCode, Timestamp, SpanAttributes Map(...), ResourceAttributes Map(...)

Map access syntax: LogAttributes['key']`,
        ),
});
```

Optionally, update the example query in `buildSystemPrompt()` in `base.agent.ts` to include a `LogAttributes` reference so the agent sees the correct name modeled:

```typescript
`Example first query:
SELECT Body, Timestamp, ServiceName, SeverityText, LogAttributes
FROM otel_logs
WHERE Body LIKE '%<error snippet>%'
  AND Timestamp > now() - INTERVAL 24 HOUR
ORDER BY Timestamp DESC
LIMIT 50`
```

**Why this fix breaks the causal chain:** The agent generates its SQL purely from the context provided in the tool definition and system prompt. With correct column names documented at the tool-call layer, the agent will select `LogAttributes` on its first attempt. The ClickHouse rejection `Unknown expression identifier 'Attributes'` cannot occur if `Attributes` is never emitted in the query — which it won't be once the agent is explicitly told the correct column name.


---
