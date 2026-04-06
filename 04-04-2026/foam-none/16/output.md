[Foam Trace ID: fefeb84c6d9a901b65de19edb32d8d76] ## TL;DR

The RCA Summary Service (`rca-summary.service.ts`) attempted to call Azure OpenAI with deployment name `gpt-5-mini`, which does not exist on the Azure resource `perla-mbgwr1sv-eastus2`. `gpt-5-mini` is not a valid OpenAI model name — it is almost certainly a misconfiguration (likely intended to be `gpt-4o-mini`). The `ai-fallback` module correctly classified the resulting HTTP 404 as non-retryable, so no fallback models were tried.

## What Broke and Why

The error occurs in a **post-processing step** of the issue-solver pipeline, not during the main agent run. After the DeepResearchAgent successfully completes its ~5.87-minute run using Claude Sonnet/Haiku/Opus models, the worker triggers the RCA Summary Service to generate a summary using a separate OpenAI model:

```
09:29:24.133 — [RcaSummary] Generating post-agent RCA summary
09:29:24.469 — AI_APICallError: Resource not found
```

The RCA Summary Service at `src/services/rca-summary.service.ts:17` calls `generateText()` via the Vercel AI SDK's Azure Responses provider (`azure.responses`), configured with model identifier `gpt-5-mini`. The SDK constructs the following API URL from this identifier:

```
https://perla-mbgwr1sv-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-5-mini/responses?api-version=2024-12-01-preview
```

The string `gpt-5-mini` is used as both the Azure deployment name in the URL path (`/deployments/gpt-5-mini/`) and the `model` field in the request body. **However, no deployment named `gpt-5-mini` exists on the Azure OpenAI resource `perla-mbgwr1sv-eastus2`.** Azure returns HTTP 404 "Resource not found."

`gpt-5-mini` is **not a valid OpenAI model name**. Known OpenAI mini-class models follow naming patterns like `gpt-4o-mini`, `o1-mini`, or `o3-mini`. The name `gpt-5-mini` appears to be a typo or misconfiguration — most likely the intended model was `gpt-4o-mini` (where `4o` was mistyped as `5`).

The call goes through the `ai-fallback` `FallbackModel.retry()` mechanism, but the fallback chain does **not** activate because `defaultShouldRetryThisError` only retries server/capacity errors (HTTP 429, 5xx). A 404 is a client error — the code explicitly checks:

```typescript
// Only retry if it's a server/capacity error
const shouldRetry = this.settings.shouldRetryThisError || defaultShouldRetryThisError
if (!shouldRetry(lastError)) {
    // immediately throw, no fallback
```

The error propagates up and is caught at `issue-solver.worker.ts:109`, logged as `"Failed to update Braintrust metadata"` with `handled: true`. The main job still completes successfully, but the Braintrust metadata update containing the RCA summary is lost.

**Alternative hypothesis considered**: The `/responses` API endpoint might be unsupported with API version `2024-12-01-preview`. The SDK did emit a compatibility warning: `"AI SDK Warning (azure.responses / gpt-5-mini): The feature 'specificationVersion' is used in a compatibility mode."` However, Azure returns specific error messages like `OperationNotSupported` for unsupported API paths, whereas "Resource not found" specifically indicates a missing deployment. Even if the API version issue exists as a secondary problem, the primary cause is the non-existent deployment name.

## Fix

**Correct the model/deployment name** in the RCA Summary Service configuration from `gpt-5-mini` to the actual deployment name that exists on the Azure OpenAI resource `perla-mbgwr1sv-eastus2` (most likely `gpt-4o-mini` or whatever deployment name was provisioned).

Specifically:
1. **In the configuration source** (environment variable, config file, or hardcoded value in `src/services/rca-summary.service.ts`): Change `gpt-5-mini` to the correct deployment name (e.g., `gpt-4o-mini`).
2. **Verify the deployment exists**: Confirm the target deployment name is actually provisioned on the `perla-mbgwr1sv-eastus2` Azure OpenAI resource.
3. **Verify API version compatibility**: Ensure the API version `2024-12-01-preview` supports the `/responses` endpoint on Azure, or switch to the Chat Completions API path (`azure('gpt-4o-mini')` instead of `azure.responses('gpt-4o-mini')`) if the Responses API is not yet supported.

This fix breaks the causal chain at the root: with a valid deployment name, the Azure API call will succeed (or fail with a meaningful, retryable error), and the RCA summary will be generated and stored in Braintrust metadata as intended.

---
