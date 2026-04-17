[Foam Trace ID: 8d1bb04867d5d251732ea333ea1547fd] ## TL;DR

When the `FallbackModel` rotated to the Google Cloud Vertex AI slot, it called `claude-3-7-sonnet@20250219` at `locations/global`, which returned HTTP 404 because that model is not available (or not enabled) for GCP project `foam-ai-452314` at the `global` location. The root cause is a misconfigured entry in the hardcoded `ANTHROPIC_TO_VERTEX` mapping table in `mewtwo/src/llms/ai-sdk/registry.ts`. The `FallbackModel` caught the error (marked `isRetryable: false`) and recovered to `claude-opus-4-5-20251101` via direct Anthropic API, so no user-facing failure occurred — but the 404 is a persistent configuration error that fires every time this slot is tried.

---

## What Broke and Why

### Causal Chain

**1. Hardcoded Vertex AI model ID in registry**

In `/repo/mewtwo/src/llms/ai-sdk/registry.ts`, the `ANTHROPIC_TO_VERTEX` mapping table hardcodes the Vertex AI model ID for Claude 3.7 Sonnet:

```typescript
// Claude 3.7 family
[CLAUDE_SONNET_37]: 'claude-3-7-sonnet@20250219',   // line 120
```

**2. FallbackModel slot ordering**

The `anthropic()` helper constructs a `FallbackModel` with three slots for each model ID. For `CLAUDE_SONNET_37 = 'claude-3-7-sonnet-20250219'`, the slot order is:

```
1. Direct Anthropic API   → claude-3-7-sonnet-20250219
2. Vertex AI              → claude-3-7-sonnet@20250219   ← the failing slot
3. Amazon Bedrock         → us.anthropic.claude-3-7-sonnet-20250219-v1:0
```

**3. The 404 from Vertex AI**

When load or rate-limits caused the FallbackModel to rotate to slot 2, the Vertex AI endpoint returned:

```
POST https://aiplatform.googleapis.com/v1/projects/foam-ai-452314/locations/global/publishers/anthropic/models/claude-3-7-sonnet@20250219:streamRawPredict

HTTP 404:
{
  "error": {
    "code": 404,
    "message": "Publisher Model `projects/foam-ai-452314/locations/global/publishers/anthropic/models/claude-3-7-sonnet@20250219` was not found or your project does not have access to it.",
    "status": "NOT_FOUND"
  }
}
```

The `@` separator format is correct for Vertex AI (confirmed by the code comment and all other entries in the same map, e.g. `claude-sonnet-4@20250514`). The failure is specific to `claude-3-7-sonnet@20250219` at the `global` location — the model is either not yet available in `global` (vs. a specific region like `us-east5`), or the GCP project `foam-ai-452314` has not been granted access to it through the Vertex AI Model Garden.

**4. FallbackModel recovery**

The error was caught with `isRetryable: false`. The `FallbackModel` skipped the slot and continued to `claude-opus-4-5-20251101` via direct Anthropic API (spans s17–s20), which succeeded. The parent `ai.streamText` span completed with `status=Unset` (no propagated error). The failing span `2c7eb868231ca02a` is the only error span in the trace — all 13 sibling `doStream` spans succeeded.

This means the error is **non-fatal but persistent**: every time the system rotates to the Vertex AI slot for `claude-3-7-sonnet`, it will always 404, consuming 490ms and generating a logged error before falling through.

---

## Fix

**Option A (preferred) — Enable the model on Vertex AI for the GCP project:**

In the Google Cloud Console for project `foam-ai-452314`, navigate to Vertex AI Model Garden and request/enable access to `claude-3-7-sonnet@20250219`. Also verify whether the model requires a specific regional endpoint (e.g., `us-east5`) rather than `global`. If a different region is needed, update the Vertex AI client initialization in `registry.ts` to point to the correct location.

**Option B — Remove the broken mapping entry until access is confirmed:**

In `/repo/mewtwo/src/llms/ai-sdk/registry.ts`, remove or comment out the Claude 3.7 Sonnet entry from `ANTHROPIC_TO_VERTEX` until Vertex AI access is verified:

```typescript
const ANTHROPIC_TO_VERTEX: Record<string, string> = {
    // Claude 4.5 family
    [CLAUDE_SONNET_45]: 'claude-sonnet-4-5@20250929',

    // Claude 4 family
    [CLAUDE_SONNET_4]: 'claude-sonnet-4@20250514',
    [CLAUDE_OPUS_41]: 'claude-opus-4-1@20250805',
    [CLAUDE_OPUS_4]:  'claude-opus-4@20250514',

    // Claude 3.7 family — REMOVED: not available in 'global' location for foam-ai-452314
    // [CLAUDE_SONNET_37]: 'claude-3-7-sonnet@20250219',

    // Claude 3.5 family
    [CLAUDE_HAIKU_35]: 'claude-3-5-haiku@20241022',

    // Claude 3 family
    [CLAUDE_HAIKU_3]:  'claude-3-haiku@20240307',
};
```

**Why this fix breaks the causal chain:** Removing the entry means `vertexModelId` is `undefined` for `CLAUDE_SONNET_37`, so `anthropicVertex(vertexModelId)` is never pushed into the `models` array. The Vertex AI slot never appears in the `FallbackModel`, the 404 request is never made, and the error cannot recur. The FallbackModel still has the direct Anthropic API and Amazon Bedrock slots as healthy fallbacks.


---
