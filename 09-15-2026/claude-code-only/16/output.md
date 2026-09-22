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
- Total latency: 336 seconds
- Token usage: 328,686 + 21,256 = 349,942 tokens

**Tool Usage:**
- Top 3 most-used tools: Grep, Agent, Glob
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
