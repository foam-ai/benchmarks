## TL;DR
AI agents generate invalid ClickHouse SQL because the `queryOtel` tool description and agent prompts lack table schemas, causing the LLM to use `LIKE` on `Map(String, String)` columns and invent non-existent column names.

## What Broke and Why

The Mewtwo service uses AI agents (SimpletonAgent, DeepResearchAgent, DeepResearchCombinedHypoPlanAgent) that generate ClickHouse SQL queries at runtime to investigate production errors. These queries are executed via the `queryOtel` tool (`mewtwo/src/agents/tools/query-otel.tool.ts`), which passes raw AI-generated SQL directly to the ClickHouse client.

**The failure mechanism:**

1. The `queryOtel` tool's description is minimal: `"Runs a ClickHouse SQL query and returns the results."` — it provides zero schema information about the `otel_traces` and `otel_logs` tables.

2. The agent system prompts (in `mewtwo/src/agents/simpleton/system-prompt.ts`, `mewtwo/src/agents/deep-research/prompts/execute.ts`, etc.) also lack inline table schemas. They mention "otel_logs, otel_traces tables" but never specify column names or types.

3. The simpleton agent's system prompt includes an example query that uses `LIKE` on `Body` (a valid String column in `otel_logs`):
   ```sql
   SELECT Body, Timestamp, ServiceName, SeverityText 
   FROM otel_logs 
   WHERE Body LIKE '%${errorSnippet}%'
   ```
   The AI extrapolates this `LIKE` pattern to `SpanAttributes` in `otel_traces`, but `SpanAttributes` is `Map(LowCardinality(String), String)` — a Map type that does not support `LIKE`.

4. While the correct schema documentation exists in `mewtwo/references/traces.md` and `mewtwo/references/logs.md`, agents can only access it through the optional `executeGrep` tool. The SimpletonAgent and DeepResearchAgent (execute phase) do not have `executeGrep` in their toolset, so they cannot look up schemas at all. They must guess column names and types — and often guess wrong.

5. ClickHouse rejects the malformed SQL with errors like:
   - `Illegal type Map(String, String) of argument of function like` (LIKE on SpanAttributes)
   - `Unknown expression identifier 'Status'` (should be `StatusCode`)
   - `Unknown expression identifier 'Attributes'` (should be `LogAttributes`)
   - `Unknown expression identifier 'Body'` in otel_traces (Body only exists in otel_logs)
   - `Unknown expression identifier 'SpanStatusCode'` (should be `StatusCode`)

6. In `query-otel.tool.ts`, the ClickHouse client error is caught, reported to Sentry via `foam.captureException(error)`, and returned as JSON to the AI. This creates 4167+ Sentry events (MEWTWO-8) as the agents repeatedly generate invalid SQL across many investigation runs.

**Causality chain:**
Agent prompt lacks schema → LLM hallucinates column names/types → Invalid SQL generated → Sent to ClickHouse without validation → ClickHouse rejects with type error → Error captured in Sentry → Error returned to LLM (which may retry with same mistakes)

## Fix

**Primary fix — Add table schemas to the `queryOtel` tool description** (`mewtwo/src/agents/tools/query-otel.tool.ts`):

Embed the essential schema information directly in the tool description so every agent that calls `queryOtel` knows the correct column names and types:

```typescript
const schema = z.object({
	sql: z.string().describe('ClickHouse SQL query to run.'),
});

const TOOL_DESCRIPTION = `Runs a ClickHouse SQL query and returns the results.

## Table Schemas

### otel_traces columns:
Timestamp (DateTime64), TraceId (String), SpanId (String), ParentSpanId (String), 
SpanName (LowCardinality String), SpanKind (LowCardinality String), ServiceName (LowCardinality String),
ResourceAttributes (Map(String, String)), SpanAttributes (Map(String, String)), 
Duration (UInt64), StatusCode (LowCardinality String), StatusMessage (String),
Events.Timestamp (Array), Events.Name (Array), Events.Attributes (Array of Maps)

### otel_logs columns:
Timestamp (DateTime64), TraceId (String), SpanId (String), SeverityText (LowCardinality String),
SeverityNumber (UInt8), ServiceName (LowCardinality String), Body (String),
ResourceAttributes (Map(String, String)), LogAttributes (Map(String, String))

## CRITICAL: Map column rules
SpanAttributes, ResourceAttributes, LogAttributes, ScopeAttributes are Map(String, String) types.
- NEVER use LIKE directly on Map columns. Use: SpanAttributes['key'] LIKE '%value%'
- To search all values: arrayExists(v -> v LIKE '%pattern%', mapValues(SpanAttributes))
- To display: toString(SpanAttributes)
- Body and SpanName are String types and support LIKE directly.
- Body exists ONLY in otel_logs. Do NOT use Body in otel_traces queries.
- The column is StatusCode, NOT Status or SpanStatusCode.`;
```

Then update the tool creation:
```typescript
export function createQueryOtelTool(ctx: ToolContext) {
	return tool({
		description: TOOL_DESCRIPTION,
		inputSchema: schema,
		execute: async ({ sql }: z.infer<typeof schema>) => {
			// ... existing implementation
		},
	});
}
```

**Secondary fix — Add SQL pre-validation** in `query-otel.tool.ts` to catch known invalid patterns before they hit ClickHouse:

```typescript
function validateSql(sql: string): string | null {
	const mapColumns = ['SpanAttributes', 'ResourceAttributes', 'LogAttributes', 'ScopeAttributes'];
	for (const col of mapColumns) {
		const regex = new RegExp(`\\b${col}\\b\\s+LIKE\\b`, 'i');
		if (regex.test(sql)) {
			return `Cannot use LIKE directly on Map column '${col}'. Use ${col}['key'] LIKE '%value%' or arrayExists(v -> v LIKE '%pattern%', mapValues(${col})) instead.`;
		}
	}
	return null;
}
```

Return the validation error directly to the AI agent (without hitting ClickHouse or reporting to Sentry), so it can self-correct.

**Tertiary fix — Update the simpleton system prompt** (`mewtwo/src/agents/simpleton/system-prompt.ts`) to include a trace query example alongside the logs example, showing proper Map column access:

```typescript
Example trace query:
SELECT TraceId, SpanName, Timestamp, Duration, StatusCode, SpanAttributes['http.method'] as method
FROM otel_traces
WHERE ServiceName = '${run.metadata.repoName}'
AND StatusCode = 'Error'
AND Timestamp > now() - INTERVAL 24 HOUR
ORDER BY Timestamp DESC
LIMIT 50
```

---
