[Foam Trace ID: f0f0558e148081607b1360da925a0796] ## TL;DR

The `queryOtel` tool blindly appends ` LIMIT 500` to every statement, including the agent's valid `DESCRIBE otel_logs`; the client then appends ` FORMAT JSONEachRow` and ClickHouse rejects the malformed DDL. The tool's try/catch returned the error to the agent, which recovered.

## What Broke and Why

**Observed error:** `ClickHouse error: Syntax error: failed at position ... LIMIT 500 FORMAT JSONEachRow`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** `query-otel.tool.ts` does `sql + ' LIMIT ' + limit` without checking whether the statement is a `SELECT`.

**2.** The generated statement was syntactically correct; the failure is in the tool wrapper, not the model.

## Fix

- Only append `LIMIT` to `SELECT`/`WITH` statements, or use ClickHouse `SETTINGS max_result_rows` instead of string concatenation.


---
