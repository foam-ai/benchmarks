[Foam Trace ID: aa5d2817c70fe6cedaf8816f1870b20b] ## TL;DR

The `AI_RetryError: Failed after 3 attempts. Last error: Not Found` occurred because the model name `claude-haiku-4-5-20251001` was sent to the Anthropic direct API (`api.anthropic.com`), where it doesn't exist (404). The root cause is an incorrect provider ordering in the `anthropic()` function in the model registry — `anthropicDirect` is tried first despite only being intended as the final fallback, and this model is only available via AWS Bedrock. The retry mechanism exhausts all attempts against the invalid endpoint before the fallback chain can try Bedrock.

## What Broke and Why

The system uses a `SimpletonAgent` that calls `registry.languageModel('bubbles:agent')`, which resolves to a two-level fallback chain defined in `/repo/mewtwo/src/llms/ai-sdk/registry.ts`:

```typescript
const bubblesModel = createFallbackChain(
    [anthropic(CLAUDE_SONNET_4), anthropic(CLAUDE_HAIKU_45), anthropic(CLAUDE_SONNET_37)],
    'bubbles',
);
```

When the first model (Sonnet) exhausted its attempts in iteration 1, the outer fallback chain rotated to the second model: `anthropic(CLAUDE_HAIKU_45)` where `CLAUDE_HAIKU_45 = 'claude-haiku-4-5-20251001'`.

The `anthropic()` function creates an **inner** fallback chain across providers for each model:

```typescript
function anthropic(modelId: string) {
    const models = [];
    models.push(anthropicDirect(modelId));           // Position 0 — FIRST tried
    const vertexModelId = ANTHROPIC_TO_VERTEX[modelId];
    if (vertexModelId) models.push(anthropicVertex(vertexModelId));
    const bedrockModelId = ANTHROPIC_TO_BEDROCK[modelId];
    if (bedrockModelId) models.push(anthropicBedrock(bedrockModelId));  // LAST tried
    return createFallback({ models: asV2Models(models), ... });
}
```

The comment says `anthropicDirect` should be the "final fallback," but the code pushes it **first** (index 0). For `claude-haiku-4-5-20251001`:

- **`anthropicDirect('claude-haiku-4-5-20251001')`** → sends to `https://api.anthropic.com/v1/messages` → **404 Not Found** because this model name is not recognized by the Anthropic direct API
- **`anthropicBedrock('us.anthropic.claude-haiku-4-5-20251001-v1:0')`** → would route to AWS Bedrock where the model IS available — but this is tried **last**

The telemetry confirms this: all 3 retry attempts hit `https://api.anthropic.com/v1/messages` with `"model":"claude-haiku-4-5-20251001"`, receiving 404 each time:

> `AI_RetryError: Failed after 3 attempts. Last error: Not Found` with `reason: "maxRetriesExceeded"`
> Span attributes: `ai.model.provider: "amazon-bedrock"`, `ai.model.id: "us.anthropic.claude-haiku-4-5-20251001-v1:0"`
> Actual HTTP: `https://api.anthropic.com/v1/messages` with body `{"model":"claude-haiku-4-5-20251001",...}`

The provider attribute metadata shows the Bedrock mapping exists, but the actual HTTP request went exclusively to the Anthropic direct API. The `_retryWithExponentialBackoff` at the `streamText` level wraps the entire model call, so each retry re-invokes the fallback chain from the beginning — starting again with `anthropicDirect`, which fails with 404 again, never progressing to the Bedrock provider.

A secondary issue compounds this: the Vercel AI SDK's retry logic retries 404 errors (a non-retryable client error), wasting ~7 seconds on 3 identical futile attempts instead of failing fast.

## Fix

**Reorder the providers in the `anthropic()` function** so that `anthropicDirect` is pushed **last** (as the comment intended), and Bedrock/Vertex are tried first:

```typescript
function anthropic(modelId: string) {
    const models = [];

    // Try Bedrock first (primary provider)
    const bedrockModelId = ANTHROPIC_TO_BEDROCK[modelId];
    if (bedrockModelId) models.push(anthropicBedrock(bedrockModelId));

    // Try Vertex AI as secondary
    const vertexModelId = ANTHROPIC_TO_VERTEX[modelId];
    if (vertexModelId) models.push(anthropicVertex(vertexModelId));

    // Direct API as final fallback
    models.push(anthropicDirect(modelId));

    return createFallback({ models: asV2Models(models), ... });
}
```

This fix breaks the causal chain at the root: for `claude-haiku-4-5-20251001`, the fallback chain will now try **Bedrock first** (where the model exists as `us.anthropic.claude-haiku-4-5-20251001-v1:0`), succeeding without ever reaching the direct API. The direct API fallback position is reserved for models that are available there but not on Bedrock/Vertex.

As a defense-in-depth improvement, the retry policy should also be updated to not retry 404 errors (they are deterministic client errors), but the provider ordering fix alone is sufficient to prevent this failure.

---
