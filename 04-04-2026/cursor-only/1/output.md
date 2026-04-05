## TL;DR
When the Issue Solver's OpenAI adapter fails and the LLMChain falls back to the Anthropic Bedrock adapter, the thread's `toolOrder` (set for OpenAI's structured output mode) is still present, causing a hard throw because `AnthropicBedrockAdapter` does not support tool ordering.

## What Broke and Why
The Issue Solver Agent (`src/services/issue-solver/issue-solver.ts`) configures a `toolOrder` on the thread at line 195:

```typescript
thread.setToolOrder(
    ADD_REASONING_TOOL
        ? [OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']
        : ['any', 'any', 'any', 'any'],
);
```

The `createIssueSolverAgentChain` (`src/llms/role-chains.ts`, line 62-77) creates a chain of `NemesisAdapter` instances. The first uses `OPENAI_MODEL` as its primary adapter (with `[ANTHROPIC_MODEL, GEMINI_MODEL]` as evaluators), and the second uses `ANTHROPIC_MODEL` as its primary adapter (with `[GEMINI_MODEL]` as evaluators).

When the OpenAI adapter encounters a `NonRetryableLLMError` (e.g., rate limit or bad request) or exhausts its retries on `RetryableLLMError`, the `LLMChain._chat()` method (`src/llms/chain.ts`, line 162-179) increments the adapter index and falls through to the next adapter in the chain — the `NemesisAdapter` wrapping `AnthropicBedrockAdapter`.

The `NemesisAdapter.chat()` passes the **same thread object** (with `toolOrder` still set) to its inner adapter's `chat()` method. Inside `BaseLLMAdapter.chat()` (`src/llms/adapters/base.ts`, lines 149-157), there is a guard:

```typescript
const toolOrder = thread.getToolOrder();
if (toolOrder && !this.supportsToolOrder()) {
    throw new Error(
        `Tool ordering is not supported by ${this.constructor.name}. ` +
        `Only OpenAI adapter currently supports per-turn tool ordering.`,
    );
}
```

`AnthropicBedrockAdapter` inherits the base class's `supportsToolOrder()` which returns `false`. Since the thread still carries the `toolOrder`, this check throws the observed error. Critically, this is a plain `Error` (not a `RetryableLLMError` or `NonRetryableLLMError`), so the `LLMChain` does **not** catch it for fallback — it propagates all the way up as an unhandled exception.

**Causality chain:**
1. OpenAI adapter fails (rate limit, API error, etc.)
2. `LLMChain` falls back to `NemesisAdapter` wrapping `AnthropicBedrockAdapter`
3. The same `Thread` (with `toolOrder` set for OpenAI structured output) is passed through
4. `BaseLLMAdapter.chat()` detects `toolOrder` + `!supportsToolOrder()` → hard throw
5. The error is a plain `Error`, not caught by `LLMChain`'s retry/fallback logic → crash

## Fix
In `src/llms/adapters/base.ts`, change the tool-order guard in the `chat` method from a hard throw to a graceful degradation — clear the tool order and proceed without it. This allows non-OpenAI adapters to work as fallbacks without crashing, just without the tool-ordering optimization:

```typescript
// In BaseLLMAdapter.chat(), replace lines 149-157:

const toolOrder = thread.getToolOrder();

if (toolOrder && !this.supportsToolOrder()) {
    // Gracefully degrade: clear tool order for adapters that don't support it
    log().warn(
        `Tool ordering is not supported by ${this.constructor.name}. ` +
        `Clearing tool order and proceeding without it.`,
    );
    thread.setToolOrder(undefined);
}
```

This is the minimal, safest fix. The Anthropic Bedrock adapter will simply operate without tool ordering (tools are still available, just not in a prescribed sequence), which is correct behavior for a fallback path.

An alternative complementary fix would be to clear the `toolOrder` in `LLMChain._chat()` when advancing to the next adapter (i.e., when `this.index++` happens in the catch blocks), ensuring downstream adapters always get a clean thread state:

```typescript
// In LLMChain._chat(), after incrementing this.index in both catch blocks:
this.index++;
// Clear tool order that may not be supported by the next adapter
thread.setToolOrder(undefined);
return await this._chat(thread, options);
```
