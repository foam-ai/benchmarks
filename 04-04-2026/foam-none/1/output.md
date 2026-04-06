[Foam Trace ID: d27ed393cc95cbaf592bc68f04c9dd22] ## TL;DR

The IssueSolver's LLMChain fell back from the OpenAI adapter to the AnthropicBedrock adapter after ~35 minutes of operation, but the Thread object still had `toolOrder` set (a feature only OpenAI supports). The guard clause in `base.ts:153` threw a **plain `Error`** instead of a `NonRetryableLLMError`, so the chain's fallback logic didn't catch it — the error propagated up and crashed the entire job.

## What Broke and Why

The IssueSolver configures a **tool ordering** constraint on the Thread object to enforce structured, sequenced tool calls:

```typescript
// services/issue-solver/issue-solver.ts:193-199
thread.setToolOrder(
    ADD_REASONING_TOOL
        ? [OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']
        : ['any', 'any', 'any', 'any'],
);
```

The LLMChain is initialized with two adapters — OpenAI (primary) and AnthropicBedrock (fallback):

```typescript
// llms/role-chains.ts
const models = [
    [OPENAI_MODEL, [ANTHROPIC_MODEL, GEMINI_MODEL]],  // Primary
    [ANTHROPIC_MODEL, [GEMINI_MODEL]],                  // Fallback
];
```

For ~35 minutes, the OpenAI adapter successfully handled "structured output mode with tool ordering" across 12+ depth iterations. At some point (between 16:04 and 16:39, lost to log truncation), the OpenAI adapter failed with a `RetryableLLMError` or `NonRetryableLLMError`, triggering the chain's fallback to AnthropicBedrock.

The chain's `_chat` method passes the **same Thread object** (with `toolOrder` still set) to the fallback adapter:

```typescript
// llms/chain.ts — _chat method
try {
    result = await adapter.chat(thread, { maxToolCallDepth });
} catch (error) {
    if (error instanceof RetryableLLMError) {
        // retries same adapter, then advances index
        this.index++;
        return await this._chat(thread, options);
    } else if (error instanceof NonRetryableLLMError) {
        this.index++;
        return await this._chat(thread, options);
    }
    throw error;  // <-- Plain Errors propagate and crash
}
```

When the AnthropicBedrock adapter receives the request, the shared `chatFunction` in `base.ts` hits its guard clause:

```typescript
// llms/adapters/base.ts:147-157
const toolOrder = thread.getToolOrder();

if (toolOrder && !this.supportsToolOrder()) {
    throw new Error(
        `Tool ordering is not supported by ${this.constructor.name}. ` +
            `Only OpenAI adapter currently supports per-turn tool ordering.`,
    );
}
```

`AnthropicBedrockAdapter` inherits the base class's default `supportsToolOrder()` which returns `false`:

```typescript
protected supportsToolOrder(): boolean {
    return false; // Override in adapters that support it
}
```

The critical bug is that this guard throws a **plain `Error`**, not a `RetryableLLMError` or `NonRetryableLLMError`. The chain's catch block only handles those two typed errors for fallback progression — plain `Error` instances hit the `throw error` path and propagate up, crashing the entire IssueSolver job for run `5a50c084-e6ff-44aa-a47a-decbc0caf9bd` (issue #7165795370, customer: perplexity).

The AnthropicBedrock adapter **does** support regular tool calling — it just doesn't support the structured ordering feature. If the `toolOrder` were cleared or the error were properly typed, the adapter could have handled the request with unordered tool calls.

## Fix

Change the guard clause in `llms/adapters/base.ts` to throw a `NonRetryableLLMError` instead of a plain `Error`, so the LLMChain's fallback logic can properly handle it:

```typescript
// llms/adapters/base.ts:153
if (toolOrder && !this.supportsToolOrder()) {
    throw new NonRetryableLLMError(
        `Tool ordering is not supported by ${this.constructor.name}. ` +
            `Only OpenAI adapter currently supports per-turn tool ordering.`,
    );
}
```

This ensures the chain's catch block recognizes the error and advances to the next adapter (or exhausts all adapters gracefully) rather than crashing the job.

**Additionally**, for a more robust fix, the `chatFunction` should gracefully degrade by clearing the tool order when the adapter doesn't support it, allowing the AnthropicBedrock adapter to make tool calls without ordering:

```typescript
const toolOrder = thread.getToolOrder();
if (toolOrder && !this.supportsToolOrder()) {
    // Gracefully degrade: proceed without tool ordering
    thread.clearToolOrder();
}
await this._makeLLMCall(thread, _depth, _maxDepth, {});
```

This breaks the causal chain at two points: (1) the error type fix ensures the chain's fallback logic works even when adapters have capability mismatches, and (2) the graceful degradation fix ensures the AnthropicBedrock adapter can actually serve the request (with unordered tools) rather than failing at all.

---
