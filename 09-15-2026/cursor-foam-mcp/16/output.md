## TL;DR

The Azure `apiVersion` (`2024-12-01-preview`) is too old for the Responses API and the deployment name has a typo, so the endpoint returns 404.

## What Broke and Why

**Observed error:** `APICallError: 404 Resource not found (/openai/deployments/.../responses)`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** The URL includes a preview API version.

**2.** 404 is what Azure returns for unknown deployments.

## Fix

- Bump the API version and verify the deployment name.

---

## Metrics

**Performance:**
- Total latency: 490 seconds
- Token usage: 631,671 + 15,755 = 647,426 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, grep, codebase_search
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) read_file (input: the throwing function and its callers) grep (input: the error string across the repo)
