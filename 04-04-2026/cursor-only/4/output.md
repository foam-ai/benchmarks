## TL;DR
The `executeQuery` function in `query-otel.tool.ts` does not strip `FORMAT` clauses from LLM-generated SQL before passing the query to the ClickHouse client, which automatically appends its own `FORMAT JSONEachRow` — resulting in a duplicate FORMAT clause and a ClickHouse syntax error.

## What Broke and Why
The Mewtwo service uses AI agents (SimpletonAgent, DeepResearchAgent, etc.) that investigate production errors by querying ClickHouse via the `queryOtel` tool. This tool accepts LLM-generated SQL and executes it against ClickHouse.

The execution flow in `mewtwo/src/agents/tools/query-otel.tool.ts` (`executeQuery` function) is:

1. The LLM generates a ClickHouse SQL query (e.g., `SELECT * FROM otel_traces LIMIT 500 FORMAT JSONEachRow`)
2. The code trims the query and strips a trailing semicolon
3. If no `LIMIT` keyword is found, it appends `LIMIT 500`
4. The query is passed to `client.query({ query, format: 'JSONEachRow' })`

The `@clickhouse/client` library (v1.12.x), when `format: 'JSONEachRow'` is specified in the query options, **automatically appends** `\nFORMAT JSONEachRow` to the SQL string before sending it to ClickHouse.

The bug: there is no code to strip a `FORMAT` clause from the LLM-generated SQL. The system prompts instruct the LLM to "Always add a LIMIT to the query" but say nothing about omitting `FORMAT`. Since `FORMAT JSONEachRow` is valid ClickHouse SQL, the LLM can reasonably include it in generated queries.

When the LLM includes `FORMAT JSONEachRow` in its SQL, the final query sent to ClickHouse becomes:

```sql
SELECT ... LIMIT 500 FORMAT JSONEachRow
FORMAT JSONEachRow
```

ClickHouse parses the first `FORMAT JSONEachRow` as the format clause (completing the statement), then encounters the second `FORMAT JSONEachRow` and reports: *"Expected end of query."*

There is a compounding issue: if the LLM generates a query with `FORMAT JSONEachRow` but **without** `LIMIT`, the code appends `LIMIT 500` **after** the FORMAT clause (since it's just concatenated to the end), producing `... FORMAT JSONEachRow LIMIT 500`. In ClickHouse, `FORMAT` must be the final clause, so `LIMIT` appearing after it is also a syntax error.

The error message `"failed at position 26 ... 500 FORMAT JSONEachRow. Expected end of query."` confirms this: ClickHouse encountered `500 FORMAT JSONEachRow` (the LIMIT value followed by the client-appended FORMAT) as unexpected trailing text after an already-complete statement.

The stack trace shows only `@clickhouse/client` frames because the error originates from ClickHouse's HTTP response, parsed by the client library's `parseError`. The error is captured via `foam.captureException(error)` in the `queryOtel` tool's catch block before being returned to the agent as a JSON error string.

## Fix
In `mewtwo/src/agents/tools/query-otel.tool.ts`, strip any `FORMAT` clause from the LLM-generated SQL before adding `LIMIT` and before passing the query to the ClickHouse client:

```typescript
async function executeQuery(sql: string, agentName: string) {
	let query = sql.trim().replace(/;$/, '');
	// Strip any FORMAT clause — the client adds FORMAT automatically via the format option
	query = query.replace(/\s+FORMAT\s+\w+\s*$/i, '');
	if (!/\bLIMIT\b/i.test(query)) {
		query += ' LIMIT 500';
	}

	const client = await connectClickhouse();
	const result = await client.query({
		query,
		format: 'JSONEachRow',
		clickhouse_settings: { max_execution_time: 30 },
	});

	const rows = await result.json();
	let output = JSON.stringify(rows);

	const truncated = output.length > MAX_CHARS;
	if (truncated) {
		output = output.slice(0, MAX_CHARS) + '...[truncated, use narrower query]';
	}

	log().info(`[${agentName}] ClickHouse query`, { chars: output.length, truncated });
	return output;
}
```

The single-line addition `query = query.replace(/\s+FORMAT\s+\w+\s*$/i, '');` removes any trailing `FORMAT <name>` clause from the query. This ensures the ClickHouse client's automatic `FORMAT JSONEachRow` appending is the only FORMAT clause present, eliminating the duplicate.
