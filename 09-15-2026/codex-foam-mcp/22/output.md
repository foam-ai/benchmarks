## TL;DR

A minor version bump of the `ai` package changed how tool results are parsed; the new version assumes text results and crashes on structured output.

## What Broke and Why

**Observed error:** `TypeError: text2.match is not a function (ai/dist/index.mjs)`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** The stack trace is inside `ai/dist/index.mjs`.

**2.** The lockfile shows a recent `ai` upgrade.

## Fix

- Pin `ai` to the previous version.

---

## Metrics

**Performance:**
- Total latency: 307 seconds
- Token usage: 352,072 + 15,137 = 367,209 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, query-otel, shell
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
