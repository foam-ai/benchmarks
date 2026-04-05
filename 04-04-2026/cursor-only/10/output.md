## TL;DR
The model `claude-opus-4-5-20251101` used as the primary model in the `best-for-reasoning` fallback chain was not found on the Anthropic Direct API (HTTP 404), and it had no Vertex AI or Bedrock provider fallback mappings, leaving it with zero alternative providers.

## What Broke and Why

The eval service runs experiments that use an AI model registry (`mewtwo/src/llms/ai-sdk/registry.ts`) with multi-level fallback chains. Each Anthropic model is wrapped in a provider-level fallback (Direct API → Vertex AI → Bedrock), and multiple models are then wrapped in an outer model-level fallback.

The `best-for-reasoning` role (used by the `deep-research-5-phases` experiment's Hypothesize, Plan, Synthesize, and Review phases) is configured as:

```typescript
const bestForReasoningModel = createFallbackChain(
    [anthropic(CLAUDE_OPUS_45), anthropic(CLAUDE_HAIKU_45), anthropic(CLAUDE_SONNET_45)],
    'best-for-reasoning',
);
```

Where `CLAUDE_OPUS_45 = 'claude-opus-4-5-20251101'`.

The causality chain:

1. **Missing provider mappings**: `CLAUDE_OPUS_45` was added to the model constants (commit `40e5ac30`, "Adding DR agent first pass") but was **never added** to the `ANTHROPIC_TO_VERTEX` or `ANTHROPIC_TO_BEDROCK` mapping tables. This means the `anthropic(CLAUDE_OPUS_45)` call creates a fallback with exactly **one** provider — the Direct Anthropic API — instead of the intended three.

2. **Model not found on Direct API**: When the Anthropic Direct API received a request for model `claude-opus-4-5-20251101`, it returned HTTP 404 "Not Found" (`not_found_error`). This indicates the model ID either does not exist, was not yet available on the Direct API at the time, or has an incorrect date suffix.

3. **Error captured in telemetry**: The `onError` callback in the inner `createFallback` fired and called both `Sentry.captureException(error)` and `foam.captureException(error)`, recording the error to telemetry. The outer fallback chain likely recovered by falling back to `CLAUDE_HAIKU_45` or `CLAUDE_SONNET_45`, but the intermediate failure was already recorded.

4. **Fallback order mismatch (contributing factor)**: The code comment at the top of the file states the provider fallback order is "Vertex AI → Bedrock → Direct API", but the `anthropic()` function pushes Direct API **first** into the models array (line 227), making it the **primary** provider rather than the last resort. This means every request first hits the Direct API (which has lower rate limits and no provider-level redundancy for unmapped models) before trying Vertex or Bedrock.

## Fix

**Immediate fix** — Add `CLAUDE_OPUS_45` to both provider mapping tables in `mewtwo/src/llms/ai-sdk/registry.ts`:

```typescript
const ANTHROPIC_TO_BEDROCK: Record<string, string> = {
    // Claude 4.5 family
    [CLAUDE_SONNET_45]: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    [CLAUDE_HAIKU_45]: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    [CLAUDE_OPUS_45]: 'us.anthropic.claude-opus-4-5-20251101-v1:0',  // ADD THIS
    // ...
};

const ANTHROPIC_TO_VERTEX: Record<string, string> = {
    // Claude 4.5 family
    [CLAUDE_SONNET_45]: 'claude-sonnet-4-5@20250929',
    [CLAUDE_OPUS_45]: 'claude-opus-4-5@20251101',  // ADD THIS (if available on Vertex)
    // ...
};
```

**Verify model ID** — Confirm that `claude-opus-4-5-20251101` is the correct model identifier on Anthropic's API. If the model does not exist or is not yet publicly available, replace it in the `bestForReasoningModel` chain with a known-good model (e.g., `CLAUDE_OPUS_41`).

**Fix fallback order** — Reorder the `anthropic()` function so the Direct API is the **last** fallback (matching the documented intent), not the first:

```typescript
function anthropic(modelId: string) {
    const models = [];

    const vertexModelId = ANTHROPIC_TO_VERTEX[modelId];
    if (vertexModelId) {
        models.push(anthropicVertex(vertexModelId));
    }

    const bedrockModelId = ANTHROPIC_TO_BEDROCK[modelId];
    if (bedrockModelId) {
        models.push(anthropicBedrock(bedrockModelId));
    }

    // Direct API as final fallback
    models.push(anthropicDirect(modelId));

    return createFallback({ models: asV2Models(models), /* ... */ });
}
```
