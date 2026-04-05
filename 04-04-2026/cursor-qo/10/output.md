## TL;DR
The `ai-fallback` library (v1.0.7) treats HTTP 404 as a **non-retryable error**, so when the Anthropic direct API returned "Not Found" for the model, the entire multi-provider fallback chain short-circuited immediately — never attempting Vertex AI, Bedrock, or alternative models. This was compounded by a provider ordering bug where Direct API is tried first instead of last.

## What Broke and Why

### The Error
The eval service (`SimpletonAgent`) calls `registry.languageModel('bubbles:agent')` which resolves to a nested fallback chain of Anthropic models:
- **Outer chain**: Claude Sonnet 4 → Claude Haiku 4.5 → Claude Sonnet 3.7
- **Inner chain per model**: Direct API → Vertex AI → Bedrock

When executing `doStream`, the Anthropic direct API returned HTTP **404 "Not Found"** for the model `claude-sonnet-4-20250514`.

### Why the Fallback Chain Failed Completely

The root cause is in `ai-fallback` v1.0.7's `defaultShouldRetryThisError` function (`node_modules/ai-fallback/dist/index.js`):

```javascript
const retryableStatusCodes = [
    401, 403, 408, 409, 413, 429, 498, 500
];

export function defaultShouldRetryThisError(error) {
    let statusCode = error?.statusCode;
    if (statusCode && (retryableStatusCodes.includes(statusCode) || statusCode > 500)) {
        return true;
    }
    // ... checks error message against retryable patterns ...
    return false;
}
```

**HTTP 404 is NOT in the `retryableStatusCodes` list**, and the error message "Not Found" doesn't match any retryable pattern. So `defaultShouldRetryThisError` returns `false`, and the `retry()` method throws immediately:

```javascript
if (!shouldRetry(lastError)) {
    throw lastError;  // Exits without trying ANY fallback
}
```

This means:
1. Inner chain tries Direct API for `claude-sonnet-4-20250514` → 404 → **NOT RETRYABLE → THROW**
2. Outer chain catches error → 404 → **NOT RETRYABLE → THROW**
3. **Never tried**: Vertex AI, Bedrock, Haiku 4.5, Sonnet 3.7

### Compounding Bug: Wrong Provider Order
The `anthropic()` function in `mewtwo/src/llms/ai-sdk/registry.ts` has Direct API **first** in the fallback array despite comments stating the intended order is "Vertex AI → Bedrock → Direct API":

```typescript
function anthropic(modelId: string) {
    const models = [];
    // Comment says "final fallback" but it's FIRST in the array
    models.push(anthropicDirect(modelId));     // ← Tried FIRST
    models.push(anthropicVertex(vertexModelId)); // ← Tried second (if 404 were retryable)
    models.push(anthropicBedrock(bedrockModelId)); // ← Tried third (if 404 were retryable)
}
```

If the intended order (Vertex first) were implemented, the request would likely succeed on Vertex AI or Bedrock without ever hitting the failing direct API endpoint.

### Why the 404 Occurred
The Anthropic direct API returned 404 for model `claude-sonnet-4-20250514`. This is likely due to:
- Model deprecation/sunset (dated model versions are periodically retired)
- Transient Anthropic API endpoint issue

## Fix

### Fix 1: Add custom `shouldRetryThisError` to retry on 404 (immediate)
In `mewtwo/src/llms/ai-sdk/registry.ts`, add a custom retry function to both `anthropic()` and `createFallbackChain()`:

```typescript
function shouldRetryOnModelNotFound(error: unknown): boolean {
    const statusCode = (error as any)?.statusCode;
    // Retry on 404 (model may exist on other providers) in addition to defaults
    if (statusCode === 404) return true;
    return defaultShouldRetryThisError(error);
}
```

Then pass it to `createFallback`:
```typescript
return createFallback({
    models: asV2Models(models),
    shouldRetryThisError: shouldRetryOnModelNotFound,
    onError: ...,
});
```

### Fix 2: Correct provider ordering to match documented intent
Reorder the providers in the `anthropic()` function so managed cloud providers are tried first:

```typescript
function anthropic(modelId: string) {
    const models = [];
    // 1. Try Vertex AI first (most reliable managed service)
    const vertexModelId = ANTHROPIC_TO_VERTEX[modelId];
    if (vertexModelId) {
        models.push(anthropicVertex(vertexModelId));
    }
    // 2. Try Bedrock as second option
    const bedrockModelId = ANTHROPIC_TO_BEDROCK[modelId];
    if (bedrockModelId) {
        models.push(anthropicBedrock(bedrockModelId));
    }
    // 3. Direct API as final fallback
    models.push(anthropicDirect(modelId));
    return createFallback({ ... });
}
```

### Fix 3: Update model IDs if deprecated
Verify that `claude-sonnet-4-20250514` is still a valid model ID on the Anthropic API. If deprecated, update to the current supported version or use the non-dated alias.

---
