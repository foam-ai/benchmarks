## TL;DR
The issue solver unconditionally sets a `toolOrder` of `['any', 'any', 'any', 'any']` on the thread, which triggers a hard error when the LLM chain falls back from OpenAI to the `AnthropicBedrockAdapter` (which doesn't support tool ordering).

## What Broke and Why

**The error:** `Error: Tool ordering is not supported by AnthropicBedrockAdapter. Only OpenAI adapter currently supports per-turn tool ordering.`

**The causality chain:**

1. **Unconditional `toolOrder` setting in `issue-solver.ts`:** At line 150, `ADD_REASONING_TOOL` is hardcoded to `false`. Despite this, lines 195–199 unconditionally set a `toolOrder` on the thread:
   ```typescript
   thread.setToolOrder(
       ADD_REASONING_TOOL
           ? [OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']
           : ['any', 'any', 'any', 'any'],
   );
   ```
   When `ADD_REASONING_TOOL` is `false`, this sets `toolOrder` to `['any', 'any', 'any', 'any']` — an array of all-wildcard entries that imposes no meaningful constraint, but is still a truthy value.

2. **LLM chain fallback path:** The `createIssueSolverAgentChain` (in `role-chains.ts`) creates a chain with two adapters:
   - Primary: `NemesisAdapter` wrapping `OpenAI` (GPT-5-mini via Azure) with Anthropic+Gemini evaluators
   - Fallback: `NemesisAdapter` wrapping `AnthropicBedrockAdapter` (Claude Sonnet 4) with Gemini evaluator

   When the primary OpenAI adapter fails with a `NonRetryableLLMError` (e.g., rate limit, bad request) or exhausts retries on `RetryableLLMError`, the chain (in `chain.ts` `_chat`) increments its index and falls through to the Anthropic fallback.

3. **Guard clause in `base.ts` throws:** When the Anthropic adapter's `chat()` method runs, the base class (`BaseLLMAdapter.chat`) at lines 149–157 checks:
   ```typescript
   const toolOrder = thread.getToolOrder();
   if (toolOrder && !this.supportsToolOrder()) {
       throw new Error(`Tool ordering is not supported by ${this.constructor.name}...`);
   }
   ```
   `['any', 'any', 'any', 'any']` is truthy. `AnthropicBedrockAdapter` does not override `supportsToolOrder()`, so the base class returns `false`. The error is thrown.

4. **Error propagates fatally:** This error is not a `RetryableLLMError` or `NonRetryableLLMError`, so `chain.ts` `_chat` does not catch it for fallback — it re-throws at line 180. The error propagates up as an unhandled error, failing the entire issue-solving operation. Per the Sentry event metadata, it was `failed_after_retries: true` with `finalAttempt: 3`, `maxAttempts: 3`, tagged as `operation: terminal_velocity_retry`.

**Why it's semantically wrong:** A `toolOrder` of `['any', 'any', 'any', 'any']` means "any tool in any position" — functionally equivalent to no ordering constraint at all. Only the OpenAI adapter uses this to shape its structured output response format (creating numbered tool-call slots). For Anthropic/Google adapters, this all-wildcard order is meaningless and should not trigger a rejection.

## Fix

**Primary fix** — in `src/services/issue-solver/issue-solver.ts`, only set `toolOrder` when `ADD_REASONING_TOOL` is true (i.e., when there's an actual ordering constraint):

```diff
-        // Use toolOrder to force thinking,
-        // and three more optional tool calls
-        thread.setToolOrder(
-            ADD_REASONING_TOOL
-                ? [OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']
-                : ['any', 'any', 'any', 'any'],
-        );
+        // Use toolOrder to force thinking tool first, then allow any tools
+        if (ADD_REASONING_TOOL) {
+            thread.setToolOrder([OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']);
+        }
```

**Defensive hardening** — in `src/llms/adapters/base.ts`, make the guard clause smarter so an all-wildcard `toolOrder` doesn't require adapter support (prevents future regressions):

```diff
                 const toolOrder = thread.getToolOrder();
-                if (toolOrder && !this.supportsToolOrder()) {
+                const hasConstrainedToolOrder = toolOrder &&
+                    toolOrder.some(item => item !== 'any' && item !== '*');
+
+                if (hasConstrainedToolOrder && !this.supportsToolOrder()) {
                     // Only throw error if the adapter doesn't support it
                     throw new Error(
                         `Tool ordering is not supported by ${this.constructor.name}. ` +
                             `Only OpenAI adapter currently supports per-turn tool ordering.`,
                     );
                 }
```

Either fix alone resolves the error; both together provide defense-in-depth.

---
