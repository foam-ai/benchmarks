## TL;DR
The `@ai-sdk/azure` v3 package defaults to the OpenAI Responses API (`/responses` endpoint), but the Azure OpenAI `apiVersion` is set to `2024-12-01-preview`, which does not support the `/responses` endpoint—causing a 404 "Resource not found" when calling GPT-5 models through Azure.

## What Broke and Why

**The failure mechanism:**

1. **Package upgrade changed default API surface**: The `@ai-sdk/azure` package at version `^3.0.9` defaults to the OpenAI **Responses API** when a model is instantiated via `provider(deploymentName)`. In earlier major versions, the default was the **Chat Completions API** (`/chat/completions` endpoint). The v3 default sends requests to the `/responses` endpoint instead.

2. **API version mismatch**: Both Azure OpenAI provider instances in `mewtwo/src/llms/ai-sdk/registry.ts` are configured with `apiVersion: '2024-12-01-preview'`. Azure OpenAI only supports the `/responses` endpoint starting from API version `2025-03-01-preview` or later. The old API version does not recognize the `/responses` path at all.

3. **The call path**: When `rca-summary.service.ts` (or any service using a model chain containing Azure OpenAI) calls `generateText()`, the registry resolves the model through the `azure()` helper function (line 275). For GPT-5 models, this calls `azureGPT5(deploymentName)` (line 291), which in v3 creates a Responses API model. The AI SDK then constructs the URL:
   ```
   https://perla-mbgwr1sv-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-5-mini/responses?api-version=2024-12-01-preview
   ```
   Azure returns **HTTP 404** because the `/responses` path does not exist at this API version.

4. **Fallback masks the severity**: The `ai-fallback` library catches the error in `FallbackModel.retry`, the `onError` callback in `createFallbackChain` reports it to Sentry, and then the next provider in the chain (e.g., Google Gemini) handles the request. The error is "handled" (`handled: yes`) so it doesn't crash the service, but it adds latency and wastes a failed API call on every invocation.

5. **Breadcrumb evidence**: The last breadcrumb on the Sentry event confirms the 404:
   ```
   POST status_code:404 url:".../openai/deployments/gpt-5-mini/responses?api-version=2024-12-01-preview"
   ```
   And the console warning `AI SDK Warning (azure.responses / gpt-5-mini)` confirms the Responses API path is being used.

**Affected code paths**: Every model chain using `OPENAI_MODEL` (which equals `OPENAI_GPT_5_MINI_MODEL`) is affected. This includes: `validationModel`, `preLinkingComparatorModel`, `prSolverModel`, `categorizationModel`, and `conversationCompressionModel`. The `categorizationModel` is particularly risky as it has **no fallback** — `createFallbackChain([openai(OPENAI_MODEL)], 'categorization')` — meaning a failure there would be unrecoverable.

## Fix

**Option A (Recommended — minimal change):** In `mewtwo/src/llms/ai-sdk/registry.ts`, explicitly use the Chat Completions API by calling `.chat()` instead of the default provider method:

```typescript
// Line 291 — change:
return logged(Step.LLM_CALL_AZURE, azureGPT5(deploymentName));
// to:
return logged(Step.LLM_CALL_AZURE, azureGPT5.chat(deploymentName));

// Line 293 — change:
return logged(Step.LLM_CALL_AZURE, azureStandard(deploymentName));
// to:
return logged(Step.LLM_CALL_AZURE, azureStandard.chat(deploymentName));
```

This explicitly opts into the Chat Completions API that works with `apiVersion: '2024-12-01-preview'`, matching the behavior before `@ai-sdk/azure` v3 changed the default.

**Option B (If Responses API features are desired):** Update the `apiVersion` on both Azure providers to a version that supports the Responses API:

```typescript
// Line 134 — change:
const AZURE_API_VERSION = '2024-12-01-preview';
// to:
const AZURE_API_VERSION = '2025-03-01-preview';

// Line 202 — change:
apiVersion: '2024-12-01-preview',
// to:
apiVersion: '2025-03-01-preview',
```

Option A is safer as it doesn't change API behavior; Option B enables Responses API features but requires verifying that all Azure deployments support the newer API version.

---
