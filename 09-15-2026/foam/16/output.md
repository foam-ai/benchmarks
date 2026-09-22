[Foam Trace ID: 1402f8dc866f5a27bf53945882b0d1c3] ## TL;DR

`registry.ts` configures the Azure provider with `useDeploymentBasedUrls: true`, but the `perla-mbgwr1sv-eastus2` resource only serves the Responses API via v1-style `/openai/v1/responses`, not the deployment-based path, so every call 404s.

## What Broke and Why

**Observed error:** `APICallError: 404 Resource not found (/openai/deployments/.../responses)`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** The SDK configuration is valid per the AI SDK docs; the resource simply does not expose that route.

**2.** Chat completions on the same resource work, which masked the issue.

## Fix

- Set `useDeploymentBasedUrls: false` (v1 endpoints) for the responses model or point at a resource that serves the deployment path.


---
