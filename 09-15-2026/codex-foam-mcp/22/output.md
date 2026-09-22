## TL;DR

PR #401 changed `query-otel.tool.ts` to return `result.json()` under a `z.unknown()` output schema, so tool results became raw row objects; the Vercel AI SDK expects string tool output and calls `.match()` on it, which crashes.

## What Broke and Why

**Observed error:** `TypeError: text2.match is not a function (ai/dist/index.mjs)`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** The schema was widened from `z.string()` to `z.unknown()` in the same PR.

**2.** Failures begin exactly at the PR's deploy time (2026-03-18 01:37 UTC).

## Fix

- Return `JSON.stringify(rows)` (schema back to `z.string()`) or wrap the object in `{ type: 'json', value }` per the SDK's tool-result contract.

---

## Metrics

**Performance:**
- Total latency: 307 seconds
- Token usage: 352,072 + 15,137 = 367,209 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, query-otel, shell
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
