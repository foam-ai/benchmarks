[Foam Trace ID: 2fe9de4ea4d1153952679fb288f028fc] ## TL;DR

The Vertex AI Anthropic provider is configured with `location: 'global'` in `mewtwo/src/llms/ai-sdk/registry.ts`, but Anthropic Claude models on Vertex AI are only available at specific regional endpoints (e.g., `us-east5`). This causes every Vertex AI call to return HTTP 404 "Not Found." The error is normally masked by the FallbackModel falling through to direct Anthropic API or Bedrock, but in this instance all fallback providers also failed, causing the entire chain to throw `AI_APICallError: Not Found`.

## What Broke and Why

The system uses a **nested FallbackModel architecture** to call Anthropic Claude models. For each model, an inner FallbackModel wraps multiple cloud providers (Vertex AI, Direct Anthropic API, Bedrock/OpenRouter), and an outer FallbackModel wraps multiple model versions.

The Vertex AI Anthropic provider is configured in `/repo/mewtwo/src/llms/ai-sdk/registry.ts`:

```typescript
const anthropicVertex = createVertexAnthropic({
    project: 'foam-ai-452314',
    location: 'global',           // ← ROOT CAUSE
    googleAuthOptions: { keyFilename: VERTEX_GCP_CREDENTIAL_LOCATION },
});
```

The `location: 'global'` is **invalid for Anthropic partner models** on Google Cloud Vertex AI. Anthropic's Claude models are deployed to specific regional endpoints (e.g., `us-east5`, `us-central1`, `europe-west1`), not the `global` location. With `location: 'global'`, the AI SDK constructs a URL like:

```
https://global-aiplatform.googleapis.com/v1/projects/foam-ai-452314/locations/global/publishers/anthropic/models/claude-3-7-sonnet@20250219:streamRawPredict
```

This endpoint does not exist, and Vertex AI returns **HTTP 404 "Not Found"** immediately (the 490ms span duration confirms an instant rejection, not a timeout).

The model name itself (`claude-3-7-sonnet@20250219`) is valid per the `ANTHROPIC_TO_VERTEX` mapping in the code:

```typescript
const ANTHROPIC_TO_VERTEX: Record<string, string> = {
    [CLAUDE_SONNET_37]: 'claude-3-7-sonnet@20250219',  // ← correctly formatted
    // ... other models
};
```

Under normal operation, the FallbackModel chain masks this Vertex AI misconfiguration: when Vertex returns 404, the inner fallback advances to the Direct Anthropic API or Bedrock, which succeed. The telemetry confirms this pattern — **13 of 14 sibling `ai.streamText.doStream` spans succeeded** (durations 2.5s–103s), while only the failing span completed in 490ms with the error.

The visible error occurred because, for this specific invocation, **all providers in the entire nested fallback chain failed simultaneously**. The stack trace confirms the nested exhaustion with two `FallbackModel.retry` frames:

```
AI_APICallError: Not Found
    at postToApi (...)
    at AnthropicMessagesLanguageModel2.doStream (...)
    at FallbackModel.retry (...)   ← inner fallback exhausted
    at FallbackModel.retry (...)   ← outer fallback exhausted
```

The Vertex AI 404 is the **deterministic, always-present failure** in this chain. While the direct Anthropic API and other fallback providers experienced transient failures that triggered the visible error, the `location: 'global'` misconfiguration is the root cause that degrades the system's resilience by permanently eliminating one fallback provider from the pool, increasing the probability of total chain failure.

**Alternative hypothesis considered**: Could `global` be a valid Vertex AI location that experienced a transient outage? No — `global` is not a supported location for Anthropic partner models on Vertex AI. The code itself acknowledges Vertex AI availability limitations with a comment: `// [CLAUDE_HAIKU_45]: 'claude-haiku-4-5@20251001',  // "Not available in Vertex AI yet"`, indicating developer awareness of availability constraints, but the `global` location misconfiguration was not caught.

## Fix

Change the `location` parameter in `createVertexAnthropic` from `'global'` to a valid Vertex AI region where Anthropic Claude models are deployed, such as `us-east5`:

```typescript
const anthropicVertex = createVertexAnthropic({
    project: 'foam-ai-452314',
    location: 'us-east5',         // ← Valid region for Anthropic models
    googleAuthOptions: { keyFilename: VERTEX_GCP_CREDENTIAL_LOCATION },
});
```

**Why this fixes the issue**: With a valid regional endpoint, the Vertex AI provider will successfully serve Anthropic model requests instead of returning 404. This restores Vertex AI as a functioning fallback provider in the chain, so even when the Direct Anthropic API experiences transient failures, the system can fall back to Vertex AI (or vice versa). The total chain failure that produced the observed error would no longer occur because the permanent 404 failure mode is eliminated, reducing the probability of all providers failing simultaneously.

---
