[Foam Trace ID: ff67f5ef457e2620fe6c8288cee522eb] ## TL;DR

The `query-otel` tool allows an LLM agent to generate raw SQL queries against the ClickHouse `otel_logs` table, but does not provide the actual table schema (column names/types) in its tool description. The LLM hallucinated the column name `Attributes` — which does not exist — instead of the correct `LogAttributes`/`ResourceAttributes`, causing ClickHouse to reject the query with `Unknown expression identifier 'Attributes'`. This was a non-fatal, self-correcting error; subsequent queries succeeded after the LLM received the error feedback.

## What Broke and Why

The error originated in the **mewtwo** service's issue-solver worker (job #1500), which runs an AI agent (BaseAgent using Claude Sonnet) to investigate and solve issues. The agent has access to a `query-otel` tool (`src/agents/tools/query-otel.tool.ts`) that executes ClickHouse SQL queries against the `otel_logs` table.

The tool accepts two LLM-generated parameters — a natural language `intent` and a raw `sqlPreview` (the full SQL query). As logged at `query-otel.tool.ts:50`:

```
intent=Find the full error details for the "no space" error; 
sqlPreview=SELECT Body, Timestamp, ServiceName, SeverityText, Attributes 
FROM otel_logs WHERE Body LIKE '%no spac%' AND Timestamp > now() - INTERVAL 24 HOUR
```

The LLM generated a query selecting 5 columns: `Body`, `Timestamp`, `ServiceName`, `SeverityText`, and `Attributes`. The first four are valid columns in the OpenTelemetry ClickHouse exporter's `otel_logs` table. However, **`Attributes` does not exist** — the standard OTel ClickHouse exporter schema uses `LogAttributes` (for log-level attributes) and `ResourceAttributes` (for resource-level attributes), both of type `Map(LowCardinality(String), String)`. There has never been a bare `Attributes` column in the standard schema.

The root cause is that the **`query-otel` tool description does not include the actual `otel_logs` table schema**. The LLM has no information about valid column names and must guess based on its training data knowledge of OpenTelemetry concepts. `Attributes` is a core OTel concept, making it a plausible-but-incorrect guess — a classic LLM hallucination pattern.

The tool also performs **no SQL validation or column whitelisting** before execution. The invalid query was passed directly to the ClickHouse client, which rejected it at `packages/client-common/src/error/error.ts:31` with:

```
Unknown expression identifier `Attributes` in scope SELECT Body, Timestamp, 
ServiceName, SeverityText, Attributes FROM otel_logs WHERE ...
```

Notably, this error was **non-fatal**. The ClickHouse error was returned to the LLM, which self-corrected in subsequent queries — 7 following queries returned successful results (`chars=50034, truncated=true`). The overall job eventually failed for an unrelated reason (an Anthropic API error leading to "No output generated"), not because of this ClickHouse column error.

## Fix

**Include the `otel_logs` table schema in the `query-otel` tool description** so the LLM knows the correct column names when generating SQL queries. In `src/agents/tools/query-otel.tool.ts`, the tool definition/description provided to the LLM should include the available columns:

```
Available columns in otel_logs:
- Timestamp (DateTime64)
- Body (String) 
- SeverityText (LowCardinality(String))
- SeverityNumber (UInt8)
- ServiceName (LowCardinality(String))
- LogAttributes (Map(LowCardinality(String), String))
- ResourceAttributes (Map(LowCardinality(String), String))
- TraceId (String)
- SpanId (String)
```

This fix breaks the causal chain at the root: with correct column names in the tool description, the LLM will use `LogAttributes`/`ResourceAttributes` instead of hallucinating `Attributes`, and the ClickHouse query will reference valid columns.

As a secondary improvement, consider adding lightweight SQL column validation in the tool before executing queries — a simple check that referenced columns exist in a known schema whitelist would catch hallucinated column names and return a helpful error to the LLM without the ClickHouse roundtrip.

---
