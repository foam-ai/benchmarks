## TL;DR
The Vertex AI model `claude-3-7-sonnet@20250219` is not available on GCP project `foam-ai-452314`, causing the entire LLM fallback chain to fail with a 404 when the primary Anthropic Direct API was unreachable due to TLS connection errors.

## What Broke and Why

### Error Chain

1. **Trigger — Anthropic Direct API unreachable**: The eval ran in a GitHub Actions environment where TLS connections to `api.anthropic.com:443` failed with `ECONNRESET` ("Client network socket disconnected before secure TLS connection was established"). This knocked out the Direct API provider across all model variants.

2. **Fallback chain engaged**: The `bubbles:agent` model (used by `SimpletonAgent` / `ClickhouseSqlAgent`) is configured as a nested fallback:
   - **Outer chain**: `anthropic(CLAUDE_SONNET_4)` → `anthropic(CLAUDE_HAIKU_45)` → `anthropic(CLAUDE_SONNET_37)`
   - **Inner chain** (per model): Direct API → Vertex AI → AWS Bedrock

3. **First call succeeded**: At `21:53:23`, the first `streamText` call initially failed twice on Direct API (TLS errors) but succeeded on the third attempt (likely via a Vertex or Bedrock fallback), allowing the agent to begin its tool-calling loop.

4. **Second call failed entirely**: At `21:55:07`, a subsequent `streamText` call entered the fallback cascade. After the `modelResetInterval` (60s) expired, the fallback retried all providers from scratch. Direct API was still down. The cascade eventually reached `CLAUDE_SONNET_37` on Vertex AI.

5. **Fatal 404 from Vertex AI**: The model `claude-3-7-sonnet@20250219` (the Vertex AI name for Claude 3.7 Sonnet) returned HTTP 404:
   ```
   Publisher Model `projects/foam-ai-452314/locations/global/publishers/anthropic/models/claude-3-7-sonnet@20250219` 
   was not found or your project does not have access to it.
   ```
   This model was either never enabled on the GCP project or has been deprecated/removed from Vertex AI's available models.

6. **AI SDK exhausted retries**: The AI SDK's `_retryWithExponentialBackoff` (configured with `maxRetries: 2`, i.e., 3 total attempts) retried the entire fallback chain 3 times. Each attempt hit the same 404 on Vertex AI for Sonnet 3.7. Result: `AI_RetryError: Failed after 3 attempts. Last error: Not Found`.

7. **Agent produced no output**: The `streamText` call threw before generating any tokens, causing `AI_NoOutputGeneratedError`, which propagated as the eval task failure.

### Code Path

- `mewtwo/experiments/clickhouse-sql.experiment.ts` → `ClickhouseSqlAgent` extends `SimpletonAgent`
- `mewtwo/src/agents/simpleton/index.ts:96` → `registry.languageModel('bubbles:agent')`
- `mewtwo/src/llms/ai-sdk/registry.ts:329-333` → `bubblesModel` chain includes `anthropic(CLAUDE_SONNET_37)`
- `mewtwo/src/llms/ai-sdk/registry.ts:120` → `ANTHROPIC_TO_VERTEX` maps `CLAUDE_SONNET_37` to `'claude-3-7-sonnet@20250219'`
- Vertex AI project `foam-ai-452314` (location: `global`) does not have this model available → 404

### Note on commit f6c277f9

The commit "Set as undefined (#222)" only renamed `--suffix` to `--prefix` for experiment naming and changed an empty string to `undefined` in `issues.ts`. It is **not causally related** to this error. The error is a runtime infrastructure issue with model availability on Vertex AI.

## Fix

### Immediate Fix — Remove unavailable model from Vertex mapping

In `mewtwo/src/llms/ai-sdk/registry.ts`, remove `claude-3-7-sonnet@20250219` from the `ANTHROPIC_TO_VERTEX` mapping since it's not available on the `foam-ai-452314` GCP project:

```typescript
const ANTHROPIC_TO_VERTEX: Record<string, string> = {
    [CLAUDE_SONNET_45]: 'claude-sonnet-4-5@20250929',
    [CLAUDE_SONNET_4]: 'claude-sonnet-4@20250514',
    [CLAUDE_OPUS_41]: 'claude-opus-4-1@20250805',
    [CLAUDE_OPUS_4]: 'claude-opus-4@20250514',
    // REMOVED: [CLAUDE_SONNET_37]: 'claude-3-7-sonnet@20250219',  // Not available on foam-ai-452314
    [CLAUDE_HAIKU_35]: 'claude-3-5-haiku@20241022',
    [CLAUDE_HAIKU_3]: 'claude-3-haiku@20240307',
};
```

This ensures that when the fallback reaches Sonnet 3.7, it skips Vertex AI entirely and goes to Bedrock (which has a valid mapping: `us.anthropic.claude-3-7-sonnet-20250219-v1:0`).

### Secondary Fix — Improve fallback provider ordering

In the `anthropic()` function, consider reordering providers to try Bedrock before Vertex, since Bedrock appears to be more reliably available:

```typescript
function anthropic(modelId: string) {
    const models = [];
    models.push(anthropicDirect(modelId));          // 1. Direct API first
    const bedrockModelId = ANTHROPIC_TO_BEDROCK[modelId];
    if (bedrockModelId) {
        models.push(anthropicBedrock(bedrockModelId)); // 2. Bedrock second
    }
    const vertexModelId = ANTHROPIC_TO_VERTEX[modelId];
    if (vertexModelId) {
        models.push(anthropicVertex(vertexModelId));   // 3. Vertex last
    }
    return createFallback({ models: asV2Models(models), ... });
}
```

### Tertiary Fix — Audit all Vertex model availability

Run a validation check to confirm which Claude models in `ANTHROPIC_TO_VERTEX` are actually enabled on the `foam-ai-452314` GCP project. Any models that return 404 should be removed from the mapping to prevent silent fallback chain failures.

---

## Metrics

**Performance:**
- Total latency: ~120 seconds
- Token usage: N/A (estimated from tool calls) + N/A = N/A
- **Model used: opus-4.6** ← REQUIRED - DO NOT CHANGE

**Tool Usage:**
- Top 3 most-used tools: Shell, Read, Grep
- Top 3 most USEFUL tools: queryOtel (input: error logs for traceId 02d17b5bd629ce1579e8875ac7e0acd0 filtered by error/failed keywords — revealed the Vertex AI 404 response body), queryOtel (input: full trace spans showing the ai.streamText fallback chain with model IDs and status codes), Read (input: mewtwo/src/llms/ai-sdk/registry.ts — showed the ANTHROPIC_TO_VERTEX mapping and nested fallback architecture)
