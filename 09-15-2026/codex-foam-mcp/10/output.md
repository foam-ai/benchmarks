## TL;DR

The `bubblesModel` fallback chain exhausted `CLAUDE_SONNET_4` and `CLAUDE_HAIKU_45` and fell through to `CLAUDE_SONNET_37`, which is routed to Vertex AI; project `foam-ai-452314` has no entitlement to that deprecated model, Vertex returns 404, and `FallbackModel.retry` treats 404 as retryable and loops.

## What Broke and Why

**Observed error:** `404 NOT_FOUND: Publisher Model `claude-3-7-sonnet@20250219` was not found`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** `ANTHROPIC_TO_VERTEX` still maps Sonnet 3.7 even though it was deprecated in Nov 2025 for new customers.

**2.** 404 is classified alongside 5xx as retryable in `FallbackModel`.

## Fix

- Remove Sonnet 3.7 from the fallback chain and treat 404 as terminal so the chain advances to the next provider.

---

## Metrics

**Performance:**
- Total latency: 305 seconds
- Token usage: 592,604 + 9,949 = 602,553 tokens

**Tool Usage:**
- Top 3 most-used tools: query-otel, read_file, list_dir
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
