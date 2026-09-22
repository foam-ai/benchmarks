## TL;DR

`registry.ts` configures the Azure provider with `useDeploymentBasedUrls: true`, but the `perla-mbgwr1sv-eastus2` resource only serves the Responses API via v1-style `/openai/v1/responses`, not the deployment-based path, so every call 404s.

## What Broke and Why

**Observed error:** `APICallError: 404 Resource not found (/openai/deployments/.../responses)`

### Causal Chain

**1.** The SDK configuration is valid per the AI SDK docs; the resource simply does not expose that route.

**2.** Chat completions on the same resource work, which masked the issue.

## Fix

- Set `useDeploymentBasedUrls: false` (v1 endpoints) for the responses model or point at a resource that serves the deployment path.

---

## Metrics

**Performance:**
- Total latency: 555 seconds
- Token usage: 468,336 + 9,026 = 477,362 tokens

**Tool Usage:**
- Top 3 most-used tools: list_dir, codebase_search, read_file
- Top 3 most USEFUL tools: read_file (input: the throwing function and its callers) grep (input: the error string across the repo) codebase_search (input: where the failing code path is invoked)
