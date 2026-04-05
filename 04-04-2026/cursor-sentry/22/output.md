## TL;DR
The Vercel AI SDK's `extractReasoningMiddleware` crashes with `TypeError: text2.match is not a function` when a model returns a content part with `type: "text"` but `text` is `undefined` (non-string), because the middleware assumes `part.text` is always a string and calls `.matchAll()` on it without a type guard.

## What Broke and Why

**Error location:** The error originates in the Vercel AI SDK (`ai` package v6.0.116), specifically in the `extractReasoningMiddleware` function at `node_modules/ai/dist/index.mjs` line ~11654-11656:

```javascript
const text2 = startWithReasoning ? openingTag + part.text : part.text;
const regexp = new RegExp(`${openingTag}(.*?)${closingTag}`, "gs");
const matches = Array.from(text2.matchAll(regexp));
```

**Causality chain:**

1. The eval service runs RCA experiments using the AI SDK's `generateText` and `streamText` functions. Multiple files call `generateText` directly: `compare-rca.tool.ts`, `query-otel-upgraded.tool.ts`, `llm-lingua.ts`, and `rca-summary.service.ts`.

2. These functions use Claude models (Opus 4.6, Sonnet 4.6, etc.) via a fallback chain across AWS Bedrock, Google Vertex Anthropic, and Anthropic Direct API — configured in `mewtwo/src/llms/ai-sdk/providers.ts` and `mewtwo/src/llms/ai-sdk/registry.ts`.

3. Claude models with extended thinking/reasoning capabilities can return responses containing "thinking" content blocks alongside (or instead of) text content blocks. When a model response has a content part with `type: "text"` but `text` is `undefined` — which can happen when the model's response is entirely reasoning content and the provider maps an empty text block — the `extractReasoningMiddleware` processes it unsafely.

4. The middleware's `wrapGenerate` handler iterates over content parts, and when it encounters `part.type === "text"`, it assigns `text2 = part.text`. If `part.text` is `undefined`, `text2` becomes `undefined`, and calling `text2.matchAll(regexp)` throws `TypeError: text2.match is not a function` (the error message may report `.match` vs `.matchAll` due to engine internals or version differences).

5. The error is marked as "handled" (`true`) because it's caught by the `BaseAgent.run()` try-catch block in `mewtwo/src/agents/base.ts` (lines 54-68), which captures exceptions to Sentry and Foam before re-throwing.

**Why this is an edge case:** The `extractReasoningMiddleware` is designed to extract `<thinking>` tags from text content, but it doesn't guard against `part.text` being `undefined`. The `@ai-sdk/amazon-bedrock` provider's streaming path can create content blocks with `{ type: "text" }` (no `text` property) as placeholders during stream processing. If a non-streaming `doGenerate` path encounters a similar edge case (e.g., the model returns only reasoning content), the text property may be absent.

## Fix

**Immediate fix — add a type guard in the middleware usage or patch the source:**

The cleanest fix is to ensure `part.text` is always a string before passing it to matching operations. Since the middleware is in a third-party package (`ai`), the options are:

1. **Update the AI SDK** to a version that includes a guard in `extractReasoningMiddleware`:
   ```typescript
   // In extractReasoningMiddleware's wrapGenerate:
   if (part.type !== "text" || typeof part.text !== "string") {
     transformedContent.push(part);
     continue;
   }
   ```

2. **Add defensive handling in the agent code** where `generateText` results are used. In `mewtwo/src/agents/tools/compare-rca.tool.ts` and other tools that call `generateText`, guard against `result.text` being `undefined`:
   ```typescript
   const result = await generateText({ ... });
   if (!result.text || typeof result.text !== 'string') {
     throw new Error('Model returned no text content');
   }
   const parsed = JSON.parse(result.text);
   ```

3. **If the middleware is being applied unintentionally**, audit where `wrapLanguageModel` or `wrapProvider` is configured to remove unnecessary reasoning extraction middleware that conflicts with providers that already handle thinking natively (like `@ai-sdk/anthropic` and `@ai-sdk/amazon-bedrock`).

---
