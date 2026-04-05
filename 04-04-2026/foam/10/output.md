## TL;DR

The `AI_APICallError: Not Found` is caused by a stale Vertex AI model mapping: `claude-3-7-sonnet@20250219` is no longer available on Google Vertex AI, resulting in a 404 when the fallback chain attempts that provider. The error is non-fatal — the `FallbackModel` recovers via Bedrock/Direct API — but generates unnecessary error telemetry and adds ~490ms latency. The fix is to remove the `claude-3-7-sonnet@20250219` entry from the `ANTHROPIC_TO_VERTEX` mapping.

## What Broke and Why

The system uses a multi-provider fallback architecture defined in `/repo/mewtwo/src/llms/ai-sdk/registry.ts`. For each Anthropic model, the `anthropic()` helper builds a per-provider fallback chain:

1. **Direct Anthropic API** (`anthropicDirect`)
2. **Google Vertex AI** (`anthropicVertex`)
3. **AWS Bedrock** (`anthropicBedrock`)

Model IDs are translated per-provider via hardcoded mappings. The `ANTHROPIC_TO_VERTEX` map (line ~103) contains:

```typescript
const ANTHROPIC_TO_VERTEX: Record<string, string> = {
    [CLAUDE_SONNET_37]: 'claude-3-7-sonnet@20250219',
    // ...
};
```

The Vertex AI provider is configured with:
```typescript
const anthropicVertex = createVertexAnthropic({
    project: 'foam-ai-452314',
    location: 'global',
    googleAuthOptions: { keyFilename: VERTEX_GCP_CREDENTIAL_LOCATION },
});
```

The `location: 'global'` configuration is valid — telemetry proves 170 successful calls to `claude-sonnet-4@20250514` via the same Vertex AI provider. However, the older `claude-3-7-sonnet@20250219` model has been **deprecated/removed from Google Vertex AI's model garden**. This is confirmed by a 100% failure rate (1/1 attempts → HTTP 404) for this specific model on Vertex, while the same model succeeds on Direct Anthropic API (`claude-3-7-sonnet-20250219`, multiple successes) and Bedrock (`us.anthropic.claude-3-7-sonnet-20250219-v1:0`, 119 successes).

The causal chain for the observed error:
1. The `bubblesModel` fallback chain is configured as `[CLAUDE_SONNET_4, CLAUDE_HAIKU_45, CLAUDE_SONNET_37]`
2. During the eval task `foam-empty-solution-uploaded-to-s3`, the primary models were saturated or erroring, causing fallback to `CLAUDE_SONNET_37`
3. The per-provider chain for `CLAUDE_SONNET_37` first tried Direct Anthropic API (which succeeded in other spans), but for this particular call, it fell through to the Vertex AI attempt
4. Vertex AI received a request for `claude-3-7-sonnet@20250219` and returned HTTP 404 because the model no longer exists on that platform
5. The `FallbackModel.retry` propagated this as `AI_APICallError: Not Found` (span `2c7eb868231ca02a`, duration 490ms)
6. The fallback chain ultimately recovered via Bedrock, and the parent span completed successfully (164.3s total)

The codebase already acknowledges this pattern — `CLAUDE_HAIKU_45` is explicitly **commented out** in `ANTHROPIC_TO_VERTEX` with the note `// Not available in Vertex AI yet, will use Bedrock/Direct API`. The same treatment was not applied to `CLAUDE_SONNET_37` when it became unavailable on Vertex AI.

## Fix

Remove the stale `claude-3-7-sonnet@20250219` entry from the `ANTHROPIC_TO_VERTEX` mapping in `/repo/mewtwo/src/llms/ai-sdk/registry.ts`:

```diff
 const ANTHROPIC_TO_VERTEX: Record<string, string> = {
-    [CLAUDE_SONNET_37]: 'claude-3-7-sonnet@20250219',
+    // [CLAUDE_SONNET_37]: 'claude-3-7-sonnet@20250219', // Removed: model no longer available on Vertex AI
     [CLAUDE_SONNET_4]: 'claude-sonnet-4@20250514',
     // ...
 };
```

This breaks the causal chain at step 3: when `CLAUDE_SONNET_37` falls back through providers, the `anthropic()` helper checks `ANTHROPIC_TO_VERTEX[modelId]` and skips Vertex AI if no mapping exists (the mapping lookup returns `undefined`, and no Vertex model is created for the chain). The fallback proceeds directly from Direct Anthropic API to Bedrock, avoiding the 404 entirely. This eliminates the wasted 490ms latency and the spurious error telemetry, following the same pattern already established for `CLAUDE_HAIKU_45`.

---