## TL;DR

After upgrading `@ai-sdk/azure` from v2 to v3 (commit `d55fb2c`), calling `azure(modelId)` now defaults to the new **OpenAI Responses API** (`/responses` endpoint) instead of the Chat Completions API (`/chat/completions`). The Azure GPT-5 provider is hardcoded to `api-version=2024-12-01-preview`, which does not support the `/responses` endpoint, causing Azure to return HTTP 404 "Resource not found". The `ai-fallback` library correctly classifies 404s as non-retryable, so no fallback to Google Gemini occurs, and the RCA summary generation step fails entirely.

---

## What Broke and Why

### The SDK Upgrade Changed the Default API Path (Root Cause)

Commit `d55fb2c` ("SDK upgrades and more leverage of it in our current AI usage", Jan 12, 2026) upgraded the following packages:

| Package | Before | After |
|---|---|---|
| `@ai-sdk/azure` | `^2.0.45` | `^3.0.9` |
| `@ai-sdk/openai` | `^2.0.44` | `^3.0.9` |
| `ai` | `^5.0.61` | `^6.0.0` |

In **v2.x**, calling the provider as a function (`azure(modelId)`) returned an `OpenAIChatLanguageModel` that used `/chat/completions`. In **v3.x / ai@6**, the same call returns an `OpenAIResponsesLanguageModel` that uses the new Responses API endpoint (`/responses`). This is a **silent breaking change** — no code changes were needed to trigger the behavior switch; the provider's default was simply changed.

The telemetry confirms the new behavior: the AI SDK emits a warning log:
```
AI SDK Warning (azure.responses / gpt-5-mini): The feature "specificationVersion" is used in a compatibility mode.
```
The provider ID `azure.responses` (not `azure.chat`) confirms the Responses API is being used.

### The Azure API Version Is Incompatible with the Responses Endpoint

The `azureGPT5` provider is configured in `/repo/mewtwo/src/llms/ai-sdk/registry.ts` as:

```typescript
const azureGPT5 = createAzure({
    apiKey: AZURE_OPENAI_API_KEY_GPT_5,
    baseURL: `${azureGPT5Base}/openai`,  // https://perla-mbgwr1sv-eastus2.cognitiveservices.azure.com/openai
    apiVersion: '2024-12-01-preview',
    useDeploymentBasedUrls: true,
});
```

With `useDeploymentBasedUrls: true` and the Responses API default, every call to a GPT-5 family model constructs the URL:
```
POST https://perla-mbgwr1sv-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-5-mini/responses?api-version=2024-12-01-preview
```

Azure OpenAI's `/responses` endpoint was not available at `api-version=2024-12-01-preview` — it was introduced in later preview versions (e.g., `2025-03-01-preview` or newer). Azure returns a clean HTTP 404 with body `{"error":{"code":"404","message":"Resource not found"}}` (56 bytes, no `apim-error-code` header indicating a missing deployment), confirming the **endpoint path itself is not registered** at this API version.

### The Full Call Chain

The failure occurs in `rca-summary.service.ts`, which runs as a post-agent step after the DeepResearchAgent completes:

```
rca-summary.service.ts:generateRcaSummary()
  → registry.languageModel('validation:solution')
    → validationModel (FallbackModel via ai-fallback)
      → Primary: openai(OPENAI_MODEL)   [OPENAI_MODEL = 'gpt-5-mini-2025-08-07']
        → azure('gpt-5-mini-2025-08-07')
          → azureGPT5('gpt-5-mini')     [via OPENAI_TO_AZURE_DEPLOYMENT map]
            → OpenAIResponsesLanguageModel  ← NEW in v3.x
              → POST .../deployments/gpt-5-mini/responses?api-version=2024-12-01-preview
                → Azure returns HTTP 404 "Resource not found"
```

### Why the Fallback to Google Gemini Doesn't Activate

The `validationModel` fallback chain is `[openai(OPENAI_MODEL), google(GEMINI_MODEL)]`. However, `ai-fallback`'s `defaultShouldRetryThisError` function only retries **transient server-side errors** (HTTP 5xx, rate limits/429). HTTP 404 is treated as a deterministic client-side error (non-retryable), so the fallback loop exits immediately and re-throws the error:

```typescript
// ai-fallback/src/index.ts:FallbackModel.retry
if (!shouldRetry(lastError)) {
    // breaks fallback loop — Google Gemini is NEVER tried
    break;
}
```

The Google Gemini fallback is never attempted, and the RCA summary generation fails with `AI_APICallError: Resource not found`. The main agent job (issue-solver job 3991) had already completed successfully at 09:29:23.827, so only the post-agent RCA summary step is affected.

---

## Fix

### Option A — Upgrade the Azure GPT-5 API Version (Recommended)

Update the `azureGPT5` provider configuration to use an Azure OpenAI API version that supports the `/responses` endpoint:

```typescript
// In /repo/mewtwo/src/llms/ai-sdk/registry.ts
const azureGPT5 = createAzure({
    apiKey: AZURE_OPENAI_API_KEY_GPT_5,
    baseURL: `${azureGPT5Base}/openai`,
    apiVersion: '2025-03-01-preview',  // ← was '2024-12-01-preview'
    useDeploymentBasedUrls: true,
});
```

This aligns the API version with what Azure actually supports for the Responses endpoint. If the Azure resource `perla-mbgwr1sv-eastus2` supports this version, calls to `/deployments/gpt-5-mini/responses?api-version=2025-03-01-preview` will succeed.

**Why this breaks the causal chain:** The root cause is the mismatch between the SDK's default Responses API path and the Azure API version that doesn't support it. Upgrading the API version removes the mismatch — the same URL path (`/responses`) will be accepted by Azure and return a valid response instead of 404.

### Option B — Explicitly Use Chat Completions API

If the Azure GPT-5 endpoint should not use the Responses API, change all `azureGPT5(deploymentName)` calls to `azureGPT5.chat(deploymentName)` to explicitly opt into the Chat Completions endpoint (which IS supported at `2024-12-01-preview`):

```typescript
function azure(modelId: string) {
    const deploymentName = OPENAI_TO_AZURE_DEPLOYMENT[modelId] || modelId;
    const isGPT5 = [OPENAI_GPT_5_MODEL, OPENAI_GPT_5_MINI_MODEL, OPENAI_GPT_5_NANO_MODEL].includes(modelId);
    if (isGPT5) {
        return logged(Step.LLM_CALL_AZURE, azureGPT5.chat(deploymentName));  // ← .chat() explicit
    }
    return logged(Step.LLM_CALL_AZURE, azureStandard(deploymentName));
}
```

**Why this breaks the causal chain:** By explicitly calling `.chat()`, the `OpenAIChatLanguageModel` is returned (using `/chat/completions`) instead of `OpenAIResponsesLanguageModel` (using `/responses`). The 404 is never triggered because the Chat Completions endpoint is supported at `2024-12-01-preview`.

**Note:** Option A is preferred if the intent is to use OpenAI's Responses API features (e.g., `previous_response_id`, `store`, `instructions` fields visible in the request body). Option B is appropriate if Chat Completions API is sufficient and the Responses API features are not needed.

---