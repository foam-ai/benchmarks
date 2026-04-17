[Foam Trace ID: dad041ff5eb8a6de282ead58bcb66f94] ## TL;DR

`issue-solver.ts` unconditionally calls `thread.setToolOrder(['any', 'any', 'any', 'any'])` on the shared thread object before handing it to the LLM chain — regardless of which adapter will ultimately process it. When the primary OpenAI adapter fails and the chain falls back to `AnthropicBedrockAdapter`, that adapter's `chatFunction` guard immediately throws because `thread.getToolOrder()` is non-null but `AnthropicBedrockAdapter` does not implement `supportsToolOrder()` (which returns `false` for all non-OpenAI adapters). The fix is to stop setting tool order unconditionally, or to clear it before handing the thread to a non-supporting adapter.

## What Broke and Why

### Causal Chain

**1. Unconditional `setToolOrder` in `issue-solver.ts`**

In `IssueSolver.solve()` (`/repo/src/services/issue-solver/issue-solver.ts`, ~line 193), tool ordering is always stamped onto the thread before the LLM chain is invoked:

```typescript
const ADD_REASONING_TOOL = false;  // hardcoded — never changes at runtime

thread.setToolOrder(
    ADD_REASONING_TOOL
        ? [OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']
        : ['any', 'any', 'any', 'any'],   // ← always this branch
);
```

Because `ADD_REASONING_TOOL` is a hardcoded `false` constant (not a feature flag, not an env variable), `thread.setToolOrder(['any', 'any', 'any', 'any'])` fires on **every single invocation**, producing a non-null `toolOrder` on the thread. There is no adapter-type gate here.

**2. The LLM chain falls back to `AnthropicBedrockAdapter`**

`createIssueSolverAgentChain()` builds a `LLMChain` with two `NemesisAdapter` slots:
- `adapters[0]`: `NemesisAdapter` wrapping **OpenAIAdapter** (primary) + [Anthropic, Gemini] as evaluators
- `adapters[1]`: `NemesisAdapter` wrapping **AnthropicBedrockAdapter** (fallback) + [Gemini] as evaluator

The failing job (`jobId=128837`, customer `Perplexity`) had the OpenAI adapter exhaust its retries/attempts. The chain fell through to `adapters[1]`, which called `AnthropicBedrockAdapter.chat(thread, options)`. The thread — still carrying `toolOrder = ['any', 'any', 'any', 'any']` — was passed in unchanged.

**3. The guard in `chatFunction` fires**

`BaseLLMAdapter.chatFunction` (defined inside `BaseLLMAdapter.chat()`, `/llms/adapters/base.ts`, ~line 149) contains:

```typescript
const toolOrder = thread.getToolOrder();

if (toolOrder && !this.supportsToolOrder()) {
    throw new Error(
        `Tool ordering is not supported by ${this.constructor.name}. ` +
        `Only OpenAI adapter currently supports per-turn tool ordering.`
    );
}
```

`AnthropicBedrockAdapter` never overrides `supportsToolOrder()`, so it inherits the base default:

```typescript
// base.ts line 44–50
protected supportsToolOrder(): boolean {
    return false;  // Only OpenAIAdapter overrides this to true
}
```

Both conditions are met: `toolOrder` is `['any', 'any', 'any', 'any']` (truthy), and `!this.supportsToolOrder()` is `true`. The error is thrown immediately, before any LLM call is made.

**4. Span evidence**

From the telemetry span (`traceId=b30b1e21f8bd06b302d1bc92d755325a`, `spanId=cc91714721c0c5eb`):
- Model: `us.anthropic.claude-sonnet-4-20250514-v1:0` → `AnthropicBedrockAdapter`
- Thread `toolOrder`: `['any', 'any', 'any', 'any']`
- Parent span: `process issue-solver-queue` (~39 min), confirming a long-running job with prior OpenAI attempts that eventually fell back to Bedrock

The error is thrown at the very first entry into `chatFunction` on the Bedrock adapter, failing the entire fallback path.

### Why Tool Order Is `['any', 'any', 'any', 'any']` at All

`ADD_REASONING_TOOL = false` suggests this block is dead-code infrastructure from a reasoning-tool feature that was partially rolled back (or not yet shipped). The intent was to prefix an `OUTPUT_REASONING_TOOL_NAME` tool in the call order for OpenAI structured-output mode. When `ADD_REASONING_TOOL` was set to `false`, the developer removed the reasoning tool from the order array but **did not remove the `setToolOrder` call itself**, leaving a no-op `['any', 'any', 'any', 'any']` order permanently stamped on every thread — with no adapter-capability check.

## Fix

**Remove the unconditional `setToolOrder` call, or gate it on adapter capability.**

The simplest fix is to remove the `thread.setToolOrder(...)` call entirely in `issue-solver.ts`, since `ADD_REASONING_TOOL` is hardcoded `false` and `['any', 'any', 'any', 'any']` is a no-op order that conveys no actual ordering constraint — it exists only to trigger the code path that enforces an order, not to impose one.

```typescript
// BEFORE (issue-solver.ts ~line 193):
const ADD_REASONING_TOOL = false;
thread.setToolOrder(
    ADD_REASONING_TOOL
        ? [OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']
        : ['any', 'any', 'any', 'any'],
);

// AFTER: Remove the setToolOrder call entirely.
// If/when ADD_REASONING_TOOL is re-enabled for OpenAI, gate the call on
// the adapter being used (or clear toolOrder before falling back):
// if (adapter.supportsToolOrder()) {
//     thread.setToolOrder([OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']);
// }
```

**Why this breaks the causal chain:** Without `thread.setToolOrder(...)`, `thread.getToolOrder()` returns `undefined`/`null`. The guard condition `if (toolOrder && !this.supportsToolOrder())` evaluates to `false` because `toolOrder` is falsy. The error is never thrown, and `AnthropicBedrockAdapter` can proceed normally as the fallback.

**Longer-term hardening (optional):** When tool ordering is re-enabled for reasoning tools, the `setToolOrder` call should be gated on whether the active adapter supports it — either by checking `adapter.supportsToolOrder()` before calling `thread.setToolOrder(...)`, or by having `BaseLLMAdapter.chat()` silently clear `toolOrder` rather than throwing when the adapter doesn't support it (if a best-effort fallback is acceptable). The current hard-throw behavior is intentional but makes the fallback chain fragile if `toolOrder` is set upstream without adapter awareness.

---
