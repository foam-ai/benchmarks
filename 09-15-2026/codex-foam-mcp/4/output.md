## TL;DR

The `queryOtel` tool blindly appends ` LIMIT 500` to every statement, including the agent's valid `DESCRIBE otel_logs`; the client then appends ` FORMAT JSONEachRow` and ClickHouse rejects the malformed DDL. The tool's try/catch returned the error to the agent, which recovered.

## What Broke and Why

**Observed error:** `ClickHouse error: Syntax error: failed at position ... LIMIT 500 FORMAT JSONEachRow`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** `query-otel.tool.ts` does `sql + ' LIMIT ' + limit` without checking whether the statement is a `SELECT`.

**2.** The generated statement was syntactically correct; the failure is in the tool wrapper, not the model.

## Fix

- Only append `LIMIT` to `SELECT`/`WITH` statements, or use ClickHouse `SETTINGS max_result_rows` instead of string concatenation.

---

## Metrics

**Performance:**
- Total latency: 426 seconds
- Token usage: 410,520 + 7,763 = 418,283 tokens

**Tool Usage:**
- Top 3 most-used tools: shell, query-otel, update_plan
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
