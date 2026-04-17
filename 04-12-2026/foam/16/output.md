[Foam Trace ID: fa70f8b8dd7dd65aaa61271a50dd884f] ## TL;DR

The post-agent RCA summary step in `src/services/rca-summary.service.ts` calls an Azure OpenAI deployment named `gpt-5-mini` at `perla-mbgwr1sv-eastus2.cognitiveservices.azure.com`, which does not exist — returning HTTP 404 "Resource not found." The root cause is that `OPENAI_MODEL` in `constants.ts` is set to `OPENAI_GPT_5_MINI_MODEL` (`gpt-5-mini-2025-08-07`), a speculative/forward-dated model that has never been provisioned as an Azure deployment. The fix is to point `OPENAI_MODEL` to an actually-provisioned Azure deployment (e.g., `gpt-4o-mini` or `gpt-4.1-mini`) or to provision the `gpt-5-mini` deployment on the Azure resource.

---

## What Broke and Why

### Full Causal Chain

**1. Triggering operation — post-agent RCA summary**

After the main `DeepResearchAgent` completed successfully (all five phases using `anthropic.messages / claude-opus-4-5-20251101` via AWS Bedrock), the `issue-solver.worker.ts` triggered a post-agent summary step in `src/services/rca-summary.service.ts`. This step calls:

```typescript
model: registry.languageModel('validation:solution'),
```

**2. Registry resolves `'validation:solution'` → `gpt-5-mini`**

In `src/llms/ai-sdk/registry.ts`, the `'validation:solution'` role is mapped to `validationModel`:

```typescript
'validation:solution': asLanguageModel(validationModel),
```

`validationModel` is a fallback chain whose primary model is:

```typescript
const validationModel = createFallbackChain(
    [openai(OPENAI_MODEL), google(GEMINI_MODEL)],
    'validation',
);
```

**3. `OPENAI_MODEL` resolves to a non-existent deployment**

In `src/constants.ts`:

```typescript
export const OPENAI_GPT_5_MINI_MODEL = 'gpt-5-mini-2025-08-07';
export const OPENAI_MODEL = OPENAI_GPT_5_MINI_MODEL;  // line 21
```

In `registry.ts`, this model ID is mapped to an Azure deployment name via a hardcoded lookup:

```typescript
const OPENAI_TO_AZURE_DEPLOYMENT: Record<string, string> = {
    [OPENAI_GPT_5_MINI_MODEL]: 'gpt-5-mini',  // 'gpt-5-mini-2025-08-07' → 'gpt-5-mini'
    ...
};
```

This resolves to an Azure Cognitive Services call against:
```
https://perla-mbgwr1sv-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-5-mini/responses?api-version=2024-12-01-preview
```

**4. Azure returns HTTP 404 — deployment does not exist**

The deployment named `gpt-5-mini` has never been provisioned on the Azure resource `perla-mbgwr1sv-eastus2.cognitiveservices.azure.com`. Azure returns:

```json
{"error": {"code": "404", "message": "Resource not found"}}
```

The SDK wraps this as `AI_APICallError: Resource not found`, confirmed by telemetry at timestamp `2026-02-24 09:29:24.469 UTC`, span `b29230f29a44ccc4`.

**5. Fallback to Google Gemini does NOT trigger**

The `ai-fallback` `FallbackModel.retry` logic only cycles to the next model in the chain when `shouldRetryThisError` returns `true`. A 404 is explicitly classified as **non-retryable** (it is not a server/capacity error), so the fallback model `google(GEMINI_MODEL)` is never attempted. The error propagates immediately.

**6. Silent failure — job still completes**

The error is caught in `src/workers/issue-solver.worker.ts:109` and logged as `Failed to update Braintrust metadata for run ...`. Job 3991 is marked completed regardless. The RCA summary is silently dropped with no user-visible impact beyond the missing Braintrust metadata.

**Key evidence summary:**
- Telemetry confirms HTTP 404 body: `{"error":{"code":"404","message":"Resource not found"}}`
- `previous_response_id` is `undefined` — stale conversation state ruled out
- Zero prior successful calls to `azure.responses / gpt-5-mini` in the entire trace; all 5 agent phases used Anthropic/Bedrock
- `OPENAI_MODEL = OPENAI_GPT_5_MINI_MODEL = 'gpt-5-mini-2025-08-07'` is a forward-dated speculative model (dated August 2025+), consistent with it never having been deployed to Azure at time of incident (February 2026)

**Alternative hypothesis considered and eliminated:** A stale `previous_response_id` referencing an expired OpenAI Responses API conversation could also produce a 404. This was ruled out because telemetry confirms `previous_response_id` was `undefined` in the failing request — no prior response ID was referenced.

---

## Fix

**Option A (Recommended — update the constant to a real model):** Change `OPENAI_MODEL` in `src/constants.ts` from `OPENAI_GPT_5_MINI_MODEL` to a model that has an actual provisioned deployment on the Azure resource (e.g., `gpt-4o-mini` or `gpt-4.1-mini`):

```typescript
// Before:
export const OPENAI_MODEL = OPENAI_GPT_5_MINI_MODEL; // 'gpt-5-mini-2025-08-07' → no Azure deployment

// After (example — use whichever deployment exists on the Azure resource):
export const OPENAI_MODEL = OPENAI_GPT_4O_MINI_MODEL;
```

**Option B — Provision the Azure deployment:** Create a deployment named `gpt-5-mini` on `perla-mbgwr1sv-eastus2.cognitiveservices.azure.com` in the Azure portal, if `gpt-5-mini` is indeed the intended model. This requires the model to be available in the `eastus2` region.

**Why this fix breaks the causal chain:** The 404 occurs because the Azure deployment name `gpt-5-mini` (derived from `OPENAI_GPT_5_MINI_MODEL`) does not exist. Pointing `OPENAI_MODEL` to a model with a provisioned Azure deployment means the deployment lookup in `OPENAI_TO_AZURE_DEPLOYMENT` will resolve to an existing resource, the POST request will succeed, and the `AI_APICallError: Resource not found` will no longer be raised. The fallback-to-Gemini gap is also resolved as a side effect.

**Optional enhancement (non-fix):** The silent failure at `issue-solver.worker.ts:109` should ideally emit a warning-level alert or surface the error more visibly, so misconfigured models are detected immediately rather than discovered through error monitoring.


---
