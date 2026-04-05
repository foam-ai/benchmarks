## TL;DR
`@ai-sdk/azure@3.0.9` defaults to the OpenAI Responses API (`/responses` endpoint) when called as a function, but Azure OpenAI with API version `2024-12-01-preview` does not support this endpoint, returning "Resource not found".

## What Broke and Why
The `azure()` helper in `mewtwo/src/llms/ai-sdk/registry.ts` calls the Azure provider as a function — `azureGPT5(deploymentName)` and `azureStandard(deploymentName)` — to create language models. In `@ai-sdk/azure@3.0.9`, the provider's default call operator and `.languageModel()` method both return an `OpenAIResponsesLanguageModel` instance (the newer OpenAI Responses API), not an `OpenAIChatLanguageModel` (the traditional Chat Completions API).

The causality chain:
1. A role-based model chain (e.g. `prSolverModel`, `validationModel`, `categorizationModel`) uses `openai(OPENAI_MODEL)` where `OPENAI_MODEL = OPENAI_GPT_5_MINI_MODEL = 'gpt-5-mini-2025-08-07'`.
2. `openai()` delegates to `azure()`, which maps the model to deployment `'gpt-5-mini'` and calls `azureGPT5(deploymentName)`.
3. Because `@ai-sdk/azure@3.0.9` defaults to the Responses API, this creates an `OpenAIResponsesLanguageModel` that sends requests to the path `/responses`.
4. With `useDeploymentBasedUrls: true`, the constructed URL becomes: `https://perla-mbgwr1sv-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-5-mini/responses?api-version=2024-12-01-preview`.
5. Azure OpenAI at API version `2024-12-01-preview` does not expose a `/responses` endpoint — it only supports `/chat/completions`. Azure returns HTTP 404 "Resource not found".
6. The `ai-fallback` library retries across the fallback chain, but since all OpenAI models route through the same Azure provider with the same misconfiguration, every attempt fails with the same error.

This affects all OpenAI model roles in the registry: `prSolverModel`, `validationModel`, `categorizationModel`, `preLinkingComparatorModel`, `preLinkingGraderModel`, `codeGenWholeFileModel`, `drain3DeterminantModel`, `codeGenSearchReplaceModel`, and `conversationCompressionModel` (when falling back to OpenAI).

## Fix
Use `.chat()` instead of calling the Azure provider as a function, to explicitly select the Chat Completions API (`/chat/completions`) instead of the Responses API (`/responses`):

```typescript
// mewtwo/src/llms/ai-sdk/registry.ts — azure() helper

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

	if (isGPT5) {
		return logged(Step.LLM_CALL_AZURE, azureGPT5.chat(deploymentName));
	}
	return logged(Step.LLM_CALL_AZURE, azureStandard.chat(deploymentName));
}
```

The two changes are:
- `azureGPT5(deploymentName)` → `azureGPT5.chat(deploymentName)`
- `azureStandard(deploymentName)` → `azureStandard.chat(deploymentName)`

This explicitly uses `OpenAIChatLanguageModel` which sends requests to `/chat/completions` — an endpoint Azure OpenAI does support at all API versions. Alternatively, if/when Azure supports the Responses API, the `apiVersion` could be updated to a version that includes the `/responses` endpoint, and the default provider call would work.
