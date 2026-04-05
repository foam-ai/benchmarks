## TL;DR
`CLAUDE_OPUS_45` (`claude-opus-4-5-20251101`) — the primary model for `best-for-reasoning` — was missing from both the Bedrock and Vertex AI provider mapping tables in `registry.ts`, forcing every LLM call to fall through to the Anthropic Direct API only. When that single provider returned a 404, the AI SDK raised `AI_APICallError: Resource not found` and the fallback chain's `onError` captured it as a Foam exception.

## What Broke and Why

### The Error Flow

1. **Exception polling** detected new exceptions on the `mono` service for customer `674e5380f251f603c5ef1847` (Foam's own account).
2. The **issue-solver worker** triggered a `DeepResearchAgent` run (`runId: 3f988e1f-4a93-429f-a34b-b6a4f76d79d5`) using the `deep-research-with-context-management` experiment.
3. The agent's five phases (Hypothesize → Plan → Execute → Synthesize → Review) all use the `best-for-reasoning` model chain, defined as:
   ```
   anthropic(CLAUDE_OPUS_45) → anthropic(CLAUDE_HAIKU_45) → anthropic(CLAUDE_SONNET_45)
   ```
4. Each `anthropic(modelId)` helper builds a provider fallback: **Bedrock → Vertex AI → Direct API**. However, `CLAUDE_OPUS_45` (`claude-opus-4-5-20251101`) was **missing from both `ANTHROPIC_TO_BEDROCK` and `ANTHROPIC_TO_VERTEX`** mapping tables.
5. This meant the inner fallback for OPUS_45 contained **only one model** (the Anthropic Direct API), with no Bedrock or Vertex redundancy.
6. When the Direct API returned HTTP 404 for this model, the AI SDK created `AI_APICallError: Resource not found`. The fallback chain's `onError` captured the exception to Sentry and Foam (creating the telemetry record), then fell through to the next model in the outer chain (`CLAUDE_HAIKU_45` via Bedrock, which succeeded).
7. Because the `modelResetInterval` is 60 seconds and each agent phase takes 1–2 minutes, the failed OPUS_45 was retried on **every phase**, generating repeated exceptions. The one at `09:29:24` came from a later phase (~6 minutes into the agent run).

### Root Cause in Code

**File:** `mewtwo/src/llms/ai-sdk/registry.ts`

The `ANTHROPIC_TO_BEDROCK` mapping included every Claude 4.5 family model *except* OPUS_45:

```typescript
// Before fix — CLAUDE_OPUS_45 is missing
const ANTHROPIC_TO_BEDROCK: Record<string, string> = {
    [CLAUDE_SONNET_45]: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    // ← CLAUDE_OPUS_45 missing here
    [CLAUDE_HAIKU_45]: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    ...
};
```

Same gap in `ANTHROPIC_TO_VERTEX`:

```typescript
const ANTHROPIC_TO_VERTEX: Record<string, string> = {
    [CLAUDE_SONNET_45]: 'claude-sonnet-4-5@20250929',
    // ← CLAUDE_OPUS_45 missing here
    ...
};
```

Without these mappings, the `anthropic(CLAUDE_OPUS_45)` helper skipped Bedrock and Vertex, creating a fallback chain with a single model (`anthropicDirect('claude-opus-4-5-20251101')`). When that sole model returned 404, the error propagated immediately to the outer fallback chain — captured by `foam.captureException(error)` in the `onError` handler — before falling back to HAIKU_45.

## Fix

**Applied to:** `mewtwo/src/llms/ai-sdk/registry.ts`

Added the missing Bedrock and Vertex AI mappings for `CLAUDE_OPUS_45`:

```typescript
// ANTHROPIC_TO_BEDROCK — added:
[CLAUDE_OPUS_45]: 'us.anthropic.claude-opus-4-5-20251101-v1:0',

// ANTHROPIC_TO_VERTEX — added:
[CLAUDE_OPUS_45]: 'claude-opus-4-5@20251101',
```

This ensures `anthropic(CLAUDE_OPUS_45)` now builds a proper three-provider fallback chain (Bedrock → Vertex → Direct), matching the pattern of every other Claude model. The Bedrock path is the most cost-effective and reliable, and having it as the first option prevents unnecessary 404 errors and exception noise.

### Additional Finding (Secondary)

The `validation:solution` model chain (used by `generateRcaSummary` post-agent) first tries Azure OpenAI deployment `gpt-5-mini` on the GPT-5 endpoint (`perla-mbgwr1sv-eastus2`). If this deployment doesn't exist on that Azure resource, it would also produce "Resource not found" errors before falling back to Google Vertex (Gemini). Verify the `gpt-5-mini` deployment exists on the Azure GPT-5 endpoint.

---

## Metrics
**Performance:**
- Total latency: ~180 seconds
- Token usage: ~50000 input tokens + ~8000 output tokens = ~58000 total tokens
- **Model used: opus-4.6**

**Tool Usage:**
- Top 3 most-used tools: Read (8x), Shell/query-otel (12x), Grep (6x)
- Top 3 most USEFUL tools:
  - query-otel (input: `SELECT ... FROM otel_logs WHERE TraceId = '5e238a354be6f9813bd6ae5c237c14a6' ... LIMIT 100`) — revealed the full exception-polling → issue-solver → DeepResearchAgent flow and confirmed `best-for-reasoning` model usage
  - Read (input: `mewtwo/src/llms/ai-sdk/registry.ts`) — revealed the missing CLAUDE_OPUS_45 mappings in both ANTHROPIC_TO_BEDROCK and ANTHROPIC_TO_VERTEX
  - Grep (input: `registry|createProviderRegistry|experimental_customProvider`) — located the central model registry file that contained the root cause
