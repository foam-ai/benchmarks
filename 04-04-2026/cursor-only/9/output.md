## TL;DR
The Anthropic model API returned HTTP 404 ("Not Found") during the eval agent's `streamText` call, exhausting all providers in the `ai-fallback` chain and all 3 Braintrust CLI retries — a transient infrastructure failure unrelated to the code changes in this commit.

## What Broke and Why
The error `AI_RetryError: Failed after 3 attempts. Last error: Not Found` occurs at `streamStep` inside the Braintrust CLI's bundled retry wrapper (`_retryWithExponentialBackoff`). This is the AI SDK's multi-step streaming path, triggered by `SimpletonAgent.loop()` calling `this.streamText()` with `registry.languageModel('bubbles:agent')`.

The `bubbles:agent` model resolves to a two-level fallback chain:
- **Outer**: `createFallbackChain([anthropic(CLAUDE_SONNET_4), anthropic(CLAUDE_HAIKU_45), anthropic(CLAUDE_SONNET_37)])`
- **Inner** (per model): each `anthropic()` call creates a fallback of Anthropic Direct API → Vertex AI → Bedrock

For the "Not Found" error to propagate, all models across all providers must have failed, and then Braintrust's 3 retry attempts must have also exhausted. This points to a systemic transient failure — either the Braintrust CLI proxy had a routing issue resolving the compound `ai-fallback` model type, or all Anthropic API providers (Direct, Vertex, Bedrock) simultaneously returned 404 during a brief outage.

**The commit `f6c277f9` ("Set as undefined") did not cause this error.** The commit makes two changes:
1. **Experiment naming**: renames `--suffix` to `--prefix` in the CLI, workflow, and eval code — changing experiment names from `default-2026-01-22/eval-name` to `2026-01-22-default/eval-name`. This is purely cosmetic and does not affect model calls.
2. **Issues router**: changes `solutionText` from `''` to `undefined` when no S3 URL exists (`mewtwo/src/routers/issues.ts` line 83). This affects the HTTP API response serialization but is entirely outside the eval pipeline — the eval loads run documents directly from MongoDB via `findIssueSolverRunByRunId()`, never through the issues router.

Neither change touches the model registry, agent code, fallback configuration, API keys, or any code in the `streamText` call path. The eval's `task()` function in `index.eval.ts` already catches this error gracefully and returns a `[FAILED]` message, so the eval run continues — but the exception is still captured by the foam SDK telemetry.

## Fix
**Immediate (improve resilience of the agent's model calls):**

Add an explicit retry wrapper around `streamText` in `BaseAgent` with a delay between attempts, independent of the Braintrust CLI's retry, so that transient 404s from a single provider don't immediately exhaust the outer retry budget:

```typescript
// In mewtwo/src/agents/base.ts, wrap the aiStreamText call:
protected async streamText(options: StreamTextWithMessages) {
    const messagesWithCaching = this.addPromptCaching(options.messages);
    const { episodeMetadata, ...streamOptions } = options;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return aiStreamText({
                ...streamOptions,
                messages: messagesWithCaching,
                experimental_telemetry: { isEnabled: true },
                onStepFinish: (params) => {
                    this.recordEpisode(params, episodeMetadata);
                    options.onStepFinish?.(params);
                },
            });
        } catch (error) {
            if (attempt === maxAttempts) throw error;
            const delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
            log().warn(`[${this.agentName}] streamText attempt ${attempt} failed, retrying in ${delay}ms`, {
                error: error instanceof Error ? error.message : String(error),
            });
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error('Unreachable');
}
```

**Additionally**, add diagnostic logging to the `ai-fallback` `onError` callbacks in `mewtwo/src/llms/ai-sdk/registry.ts` to capture which specific provider and model ID failed, making future transient failures easier to diagnose:

```typescript
onError: (error, model) => {
    log().error('[ai-fallback] Provider failed', {
        provider: 'anthropic',
        modelId: String(model),
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
    });
    Sentry.captureException(error, { extra: { provider: 'anthropic', modelId: model } });
    foam.captureException(error);
},
```
