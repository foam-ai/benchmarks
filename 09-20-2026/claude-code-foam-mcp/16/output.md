## TL;DR

`registry.ts` configures the Azure provider with `useDeploymentBasedUrls: true`, but the `perla-mbgwr1sv-eastus2` resource only serves the Responses API via v1-style `/openai/v1/responses`, not the deployment-based path, so every call 404s.

## What Broke and Why

**Observed error:** `APICallError: 404 Resource not found (/openai/deployments/.../responses)`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** The SDK configuration is valid per the AI SDK docs; the resource simply does not expose that route.

**2.** Chat completions on the same resource work, which masked the issue.

## Fix

- Set `useDeploymentBasedUrls: false` (v1 endpoints) for the responses model or point at a resource that serves the deployment path.

---

## Metrics

**Performance:**
- Total latency: 491 seconds
- Token usage: 429,214 + 22,719 = 451,933 tokens

**Tool Usage:**
- Top 3 most-used tools: query-otel, Glob, Read
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) Read (input: the throwing function and its callers) Grep (input: the error string across the repo)
