## TL;DR
`@ai-sdk/azure` v3.0.9 (built on `@ai-sdk/openai` v3.0.9) defaults to the OpenAI Responses API (`/responses` endpoint), but Azure OpenAI with API version `2024-12-01-preview` doesn't support that endpoint, causing a 404 "Resource not found" error on every Azure-routed model call.

## What Broke and Why

The application uses the Vercel AI SDK to make LLM calls, with OpenAI models routed through Azure OpenAI Service via the `@ai-sdk/azure` provider. The model registry in `mewtwo/src/llms/ai-sdk/registry.ts` creates two Azure provider instances (`azureStandard` and `azureGPT5`) using `createAzure()`, and the `azure()` helper function calls them as `azureStandard(deploymentName)` / `azureGPT5(deploymentName)`.

The causality chain:

1. **AI SDK version upgrade**: The project uses `@ai-sdk/azure` v3.0.9, which internally depends on `@ai-sdk/openai` v3.0.9 (confirmed in `yarn.lock`). In this major version (`@ai-sdk/openai` v3.x), the **default model type changed** from `OpenAIChatLanguageModel` (Chat Completions API at `/chat/completions`) to `OpenAIResponsesLanguageModel` (Responses API at `/responses`).

2. **Provider invocation uses the default**: In `registry.ts`, the `azure()` function calls the provider directly — `azureStandard(deploymentName)` and `azureGPT5(deploymentName)` (lines 275 and 279). In v3.x, calling a provider as a function (e.g., `provider(modelId)`) returns a Responses API model by default. To get a Chat Completions model, you must explicitly use `provider.chat(modelId)`.

3. **Azure doesn't support the Responses endpoint**: The Azure providers are configured with `apiVersion: '2024-12-01-preview'`. Azure OpenAI Service only added Responses API support in later API versions. When the SDK sends a request to `{azureEndpoint}/openai/deployments/{deployment}/responses?api-version=2024-12-01-preview`, Azure returns HTTP 404 because that endpoint path doesn't exist.

4. **Error is caught by fallback, causing Sentry noise**: The `ai-fallback` library catches the error in `FallbackModel.retry` and falls back to the next model in the chain (typically an Anthropic model via Vertex/Bedrock/Direct API). The `onError` callback in `createFallbackChain` captures the error in Sentry. This is why the error has 9 occurrences but 0 impacted users — the fallback succeeds, but every Azure model call fails first, adding unnecessary latency and Sentry noise.

The stacktrace confirms this: `OpenAIResponsesLanguageModel.doGenerate` → `postToApi` → `response-handler` returns the 404, which bubbles up through `FallbackModel.retry`.

## Fix

Change the `azure()` function in `mewtwo/src/llms/ai-sdk/registry.ts` to explicitly use the Chat Completions API by calling `.chat()` on the Azure provider instances instead of invoking them directly:

```typescript
function azure(modelId: string) {
	const deploymentName = OPENAI_TO_AZURE_DEPLOYMENT[modelId] || modelId;

	const isGPT5 =
		modelId === OPENAI_GPT_5_MODEL ||
		modelId === OPENAI_GPT_5_MINI_MODEL ||
		modelId === OPENAI_GPT_5_NANO_MODEL;

	log().info('[AI SDK Registry] Azure call:', {
		inputModelId: modelId,
		mappedDeployment: deploymentName,
		isGPT5,
		endpoint: isGPT5 ? 'GPT-5' : 'Standard',
	});

	// GPT-5 models use separate endpoint
	if (isGPT5) {
		return azureGPT5.chat(deploymentName);
	}

	// All other models use standard endpoint
	return azureStandard.chat(deploymentName);
}
```

The key change is `azureGPT5(deploymentName)` → `azureGPT5.chat(deploymentName)` and `azureStandard(deploymentName)` → `azureStandard.chat(deploymentName)`. The `.chat()` method forces the SDK to use the Chat Completions API (`/chat/completions` endpoint), which Azure supports with the `2024-12-01-preview` API version.

---
