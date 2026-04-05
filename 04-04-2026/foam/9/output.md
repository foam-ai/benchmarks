## TL;DR

The `AI_RetryError: Failed after 3 attempts. Last error: Not Found` was caused by the `anthropic()` helper in `registry.ts` unconditionally placing the Direct Anthropic API as the **first** provider in the fallback chain, despite the model `claude-haiku-4-5-20251001` only being available on AWS Bedrock. The direct API returned HTTP 404, all 3 retries were exhausted against the same invalid endpoint, and the working Bedrock provider was never reached. The fix is to reorder providers to match the documented order: Vertex AI → Bedrock → Direct API (last).

## What Broke and Why

The system uses a multi-provider fallback chain for AI model calls, configured in `/repo/mewtwo/src/llms/ai-sdk/registry.ts`. The `anthropic()` helper function constructs a per-model fallback chain across providers (Direct API, Vertex AI, Bedrock):

```typescript
function anthropic(modelId: string) {
    const models = [];
    // 1. Always try direct API as final fallback (uses original model ID)
    models.push(anthropicDirect(modelId));  // ← ALWAYS first, despite comment saying "final"
    // 2. Try Vertex AI as fallback (if mapping exists)
    const vertexModelId = ANTHROPIC_TO_VERTEX[modelId];
    if (vertexModelId) { models.push(anthropicVertex(vertexModelId)); }
    // 3. Try Bedrock as fallback (if mapping exists)
    const bedrockModelId = ANTHROPIC_TO_BEDROCK[modelId];
    if (bedrockModelId) { models.push(anthropicBedrock(bedrockModelId)); }
    return createFallback({ models: asV2Models(models), ... });
}
```

The file header documents the intended provider order as **"Vertex AI → Bedrock → Direct API"**, but the implementation does the exact opposite: **Direct API → Vertex AI → Bedrock**.

For `CLAUDE_HAIKU_45 = 'claude-haiku-4-5-20251001'`, this model is only available on AWS Bedrock. The Vertex AI mapping is explicitly commented out:

```typescript
// [CLAUDE_HAIKU_45]: 'claude-haiku-4-5@20251001', // Not available in Vertex AI yet, will use Bedrock/Direct API
```

So the effective fallback chain for this model is: `[anthropicDirect('claude-haiku-4-5-20251001'), anthropicBedrock('us.anthropic.claude-haiku-4-5-20251001-v1:0')]`.

When the agent's `bubblesModel` fallback chain reached `CLAUDE_HAIKU_45`, the inner `anthropic()` fallback tried the Direct Anthropic API first. The API returned HTTP 404:

```json
{"error": {"code": 404, "message": "model: claude-haiku-4-5-20251001", "status": "NOT_FOUND"}}
```

The AI SDK's built-in retry mechanism (`maxRetries: 2`, meaning 3 total attempts) then exhausted all attempts against this same failing direct API endpoint. Despite the 404 being marked `isRetryable: false`, the error was wrapped as `AI_RetryError: Failed after 3 attempts. Last error: Not Found` — and this wrapped error prevented the `ai-fallback` layer from promoting to the next provider (Bedrock) where the model actually exists and works.

Telemetry confirms the Bedrock provider **does work** for this model — earlier spans in the same trace show successful Bedrock calls for other Anthropic models via `bedrock-runtime.us-west-2.amazonaws.com`.

## Fix

Reorder the providers in the `anthropic()` helper function to match the documented intended order — Vertex AI → Bedrock → Direct API (last):

```typescript
function anthropic(modelId: string) {
    const models = [];

    // 1. Try Vertex AI first (if mapping exists)
    const vertexModelId = ANTHROPIC_TO_VERTEX[modelId];
    if (vertexModelId) {
        models.push(anthropicVertex(vertexModelId));
    }

    // 2. Try Bedrock second (if mapping exists)
    const bedrockModelId = ANTHROPIC_TO_BEDROCK[modelId];
    if (bedrockModelId) {
        models.push(anthropicBedrock(bedrockModelId));
    }

    // 3. Direct API as final fallback
    models.push(anthropicDirect(modelId));

    return createFallback({
        models: asV2Models(models),
        onError: (error, model) => {
            Sentry.captureException(error, { extra: { provider: 'anthropic', modelId: model } });
            foam.captureException(error);
        },
        modelResetInterval: 60000,
    });
}
```

This fix breaks the causal chain at the root: for `CLAUDE_HAIKU_45`, Bedrock (where the model exists) would be tried first, succeeding without ever reaching the Direct API that returns 404. For models available on all providers, the preferred cost/performance order (Vertex → Bedrock → Direct) is also restored. The Direct API remains as a genuine last-resort fallback, matching the existing comment's intent.

---