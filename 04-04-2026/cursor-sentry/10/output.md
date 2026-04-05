## TL;DR
Anthropic API returned HTTP 404 "Not Found" for a dated model version during Braintrust eval, and the `ai-fallback` library's `onError` callback unnecessarily sends every intermediate fallback failure to Sentry as an exception.

## What Broke and Why

The error `AI_APICallError: Not Found` originated during a Braintrust eval run of the `default` experiment (commit `f6c277f9`), which uses the `SimpletonAgent` with the `bubbles:agent` model from the AI SDK registry.

**The model fallback chain:**

The `bubbles:agent` model maps to `bubblesModel`, a nested two-level fallback chain:

- **Outer fallback** (model alternatives): `claude-sonnet-4-20250514` → `claude-haiku-4-5-20251001` → `claude-3-7-sonnet-20250219`
- **Inner fallback** (provider alternatives per model): Direct Anthropic API → Vertex AI → AWS Bedrock

**How the error propagated:**

1. The `SimpletonAgent.loop()` calls `this.streamText()` with `registry.languageModel('bubbles:agent')`.
2. The inner fallback for the first model (`claude-sonnet-4-20250514`) tries the **Direct Anthropic API** first.
3. The Anthropic API returns **HTTP 404 "Not Found"** — the dated model version `claude-sonnet-4-20250514` was not found. This likely indicates the specific dated version was **deprecated or temporarily unavailable** on the Anthropic API by January 22, 2026 (8 months after its May 2025 release).
4. The `ai-fallback` library's `onError` callback fires and calls **`Sentry.captureException(error)`** — this is the Sentry event we're investigating.
5. The fallback chain **continues** to try Vertex AI and Bedrock providers, and then tries the next models (`claude-haiku-4-5` and `claude-3-7-sonnet`).

**The critical flaw in the registry code** (`mewtwo/src/llms/ai-sdk/registry.ts`, lines 243-250):

```typescript
return createFallback({
    models: asV2Models(models),
    onError: (error, model) => {
        Sentry.captureException(error, { extra: { provider: 'anthropic', modelId: model } });
        foam.captureException(error);
    },
    modelResetInterval: 60000,
});
```

Every **intermediate** provider failure in the fallback chain triggers `Sentry.captureException()`, generating Sentry error events for failures that the fallback library is designed to handle gracefully. This creates noise — the fallback likely continued to work via an alternative provider, but the error was already reported as a critical exception.

**Why the 404 specifically:** The Anthropic API returns `not_found_error` (HTTP 404) when a model ID doesn't exist or has been deprecated. Using hardcoded dated model versions (e.g., `claude-sonnet-4-20250514`) is fragile because Anthropic periodically deprecates old dated versions while keeping aliases (e.g., `claude-sonnet-4`) active.

**Note on the commit:** The commit `f6c277f9` ("Set as undefined") only renames experiment `suffix` → `prefix` and changes `solutionText` from `''` to `undefined` in `issues.ts`. Neither change affects model configuration or API calls — this error is a pre-existing issue with the fallback error reporting and model version pinning, not caused by this commit.

## Fix

**Fix 1 (Immediate): Stop reporting intermediate fallback failures to Sentry as exceptions.**

In `mewtwo/src/llms/ai-sdk/registry.ts`, change the `onError` callbacks in both `anthropic()` and `createFallbackChain()` to use warning-level breadcrumbs instead of `captureException`:

```typescript
// In anthropic() function (inner fallback)
onError: (error, model) => {
    Sentry.addBreadcrumb({
        category: 'ai-fallback',
        message: `Provider fallback triggered: ${error instanceof Error ? error.message : String(error)}`,
        level: 'warning',
        data: { provider: 'anthropic', modelId: String(model) },
    });
},

// In createFallbackChain() function (outer fallback)  
onError: (error, modelId) => {
    Sentry.addBreadcrumb({
        category: 'ai-fallback',
        message: `Model fallback triggered: ${error instanceof Error ? error.message : String(error)}`,
        level: 'warning',
        data: { role, modelId: String(modelId) },
    });
},
```

This way, intermediate failures are recorded as breadcrumbs (visible in the context of actual errors) but don't generate standalone Sentry events. The `BaseAgent.run()` catch block already captures the final error to Sentry if ALL fallbacks are exhausted.

**Fix 2 (Robustness): Use model aliases instead of dated versions where possible.**

Update the model constants to use non-dated aliases that Anthropic keeps pointing to the latest version:

```typescript
const CLAUDE_SONNET_4 = 'claude-sonnet-4-20250514';  // Consider: 'claude-sonnet-4-latest' when available
```

**Fix 3 (Missing mappings): Add `CLAUDE_OPUS_45` to Bedrock and Vertex maps.**

The `bestForReasoningModel` uses `CLAUDE_OPUS_45 = 'claude-opus-4-5-20251101'` which has **no Bedrock or Vertex mappings** — meaning it only has Direct API as a single provider with zero fallback. Add the mappings:

```typescript
// In ANTHROPIC_TO_BEDROCK:
[CLAUDE_OPUS_45]: 'us.anthropic.claude-opus-4-5-20251101-v1:0',

// In ANTHROPIC_TO_VERTEX:
[CLAUDE_OPUS_45]: 'claude-opus-4-5@20251101',
```

---
