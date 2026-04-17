[Foam Trace ID: 5956f658e5f1852b0359617fd75ae463] ## TL;DR

The `AI_RetryError: Failed after 3 attempts. Last error: Not Found` is caused by `claude-haiku-4-5-20251001` (Claude Haiku 4.5) being configured in the `bubblesModel` provider fallback chain but unavailable on **every** configured provider: it has the wrong model name format for the direct Anthropic API (404), has no Vertex AI mapping (explicitly commented out), and the Bedrock cross-region inference profile (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) has not been enabled in the AWS account. The fix is to enable the Bedrock cross-region inference profile in the AWS account, or remove `CLAUDE_HAIKU_45` from the fallback chain until the model is accessible.

---

## What Broke and Why

### Full Causal Chain

**Step 1 — Iteration 1 runs successfully but doesn't complete.**
The `SimpletonAgent` loop starts with `registry.languageModel('bubbles:agent')`, which resolves to `bubblesModel` — an outer three-tier fallback chain:
```
1. anthropic(CLAUDE_SONNET_4)   → claude-sonnet-4-20250514  [Direct API → Vertex → Bedrock]
2. anthropic(CLAUDE_HAIKU_45)   → claude-haiku-4-5-20251001 [Direct API → (no Vertex) → Bedrock]
3. anthropic(CLAUDE_SONNET_37)  → claude-3-7-sonnet-20250219 [Direct API → Vertex → Bedrock]
```

Iteration 1 (`nudgeAttempt=1`) successfully used `claude-sonnet-4-20250514` via the direct Anthropic API over ~104 seconds, calling `clickhouseSql` and `queryOtel` tools across 7 steps. However, the agent never called the `completeTask` tool, triggering a nudge.

**Step 2 — `ai-fallback` library cools down Sonnet 4 before the nudge.**
The `ai-fallback` library is configured with `modelResetInterval: 60000` (60-second cooldown). Errors encountered during iteration 1's Bedrock/Vertex attempts for Sonnet 4 caused the library to mark those slots as degraded. By the time the nudge fires at `21:55:07`, the outer fallback chain advances past `anthropic(CLAUDE_SONNET_4)` and selects `anthropic(CLAUDE_HAIKU_45)` for iteration 2.

**Step 3 — The inner `anthropic(CLAUDE_HAIKU_45)` fallback chain tries all three providers and all fail.**

The `anthropic()` helper in `registry.ts` builds this inner chain for `CLAUDE_HAIKU_45`:

```typescript
function anthropic(modelId: string) {
    const models = [];
    models.push(anthropicDirect(modelId));          // 1st: Direct Anthropic API
    const vertexModelId = ANTHROPIC_TO_VERTEX[modelId];
    if (vertexModelId) models.push(anthropicVertex(vertexModelId)); // 2nd: Vertex AI (skipped)
    const bedrockModelId = ANTHROPIC_TO_BEDROCK[modelId];
    if (bedrockModelId) models.push(anthropicBedrock(bedrockModelId)); // 3rd: Bedrock
    return createFallback({ models: asV2Models(models), ... });
}
```

- **Direct Anthropic API** → `POST https://api.anthropic.com/v1/messages` with `{"model":"claude-haiku-4-5-20251001",...}` → **HTTP 404 Not Found**. The model name `claude-haiku-4-5-20251001` does not exist in Anthropic's direct API catalog (confirmed by telemetry log):
  ```json
  {"name":"AI_RetryError","reason":"maxRetriesExceeded","errors":[{
    "name":"AI_APICallError",
    "url":"https://api.anthropic.com/v1/messages",
    "requestBodyValues":{"model":"claude-haiku-4-5-20251001"}
  }]}
  ```

- **Vertex AI** → **Skipped entirely**. The `ANTHROPIC_TO_VERTEX` map explicitly excludes this model:
  ```typescript
  // [CLAUDE_HAIKU_45]: 'claude-haiku-4-5@20251001', // Not available in Vertex AI yet
  ```

- **Amazon Bedrock** → `POST https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream` → **HTTP 404 Not Found**. The cross-region inference profile `us.anthropic.claude-haiku-4-5-20251001-v1:0` requires explicit model access enablement in the AWS account — this step was never performed. The sibling `AI_NoOutputGeneratedError` spans (0ms duration, Error status) in the trace confirm Bedrock also returned 404 before any tokens were streamed.

**Step 4 — `AI_RetryError` surfaces.**
With `maxRetries: 2` (3 total attempts) all returning 404, the `_retryWithExponentialBackoff` wrapper exhausts its budget and throws:
```
AI_RetryError: Failed after 3 attempts. Last error: Not Found
```
This propagates up through `streamStep` → `fn` → the `SimpletonAgent` loop, terminating the eval task with `AI_NoOutputGeneratedError`.

---

## Fix

There are two complementary fixes — both should be applied:

### Fix 1 (Immediate): Enable the Bedrock cross-region inference profile in the AWS account
Request model access for `us.anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5 cross-region inference profile) in the AWS account used by the `us-west-2` Bedrock runtime. This is done via the AWS Console → Amazon Bedrock → Model Access → Enable the cross-region inference profile for Claude Haiku 4.5. Once enabled, the Bedrock path in `anthropic(CLAUDE_HAIKU_45)` will succeed, breaking the 404 chain.

### Fix 2 (Defensive): Guard against deploying models with no working provider
The `ANTHROPIC_TO_VERTEX` mapping already documents that Haiku 4.5 is not available on Vertex AI. Before adding a model to the `bubblesModel` fallback chain, verify at least one provider path is live. Until Bedrock access is confirmed enabled, `CLAUDE_HAIKU_45` should be removed from the `bubblesModel` outer chain in `registry.ts`:

```typescript
// Before (broken — no working provider path for CLAUDE_HAIKU_45):
const bubblesModel = createFallbackChain([
    anthropic(CLAUDE_SONNET_4),
    anthropic(CLAUDE_HAIKU_45),   // ← Remove until Bedrock access is enabled
    anthropic(CLAUDE_SONNET_37),
], 'bubbles');

// After (safe fallback to a model known to work):
const bubblesModel = createFallbackChain([
    anthropic(CLAUDE_SONNET_4),
    anthropic(CLAUDE_SONNET_37),
], 'bubbles');
```

**Why this breaks the causal chain:** Enabling Bedrock access removes the 404 at the Bedrock layer, giving the inner fallback chain a working provider. Removing `CLAUDE_HAIKU_45` from the outer chain entirely prevents the outer fallback from ever landing on a model with zero working providers. Either fix independently stops the error; together they are defense-in-depth.

---
