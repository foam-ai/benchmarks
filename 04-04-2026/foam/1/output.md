## TL;DR

The issue-solver unconditionally sets `toolOrder` on the conversation thread, but when the OpenAI adapter exceeds its 272K token limit and the LLM chain falls back to `AnthropicBedrockAdapter`, the chain passes the same thread with `toolOrder` still set. Since `AnthropicBedrockAdapter` doesn't support tool ordering, it throws a fatal error. The fix is to clear `toolOrder` in the chain's fallback path when the next adapter doesn't support it.

## What Broke and Why

The failure originates from a design gap in the LLM adapter chain's fallback logic when adapter-specific features are in use.

**Step 1: Unconditional toolOrder setup.** In `src/services/issue-solver/issue-solver.ts` (~line 195), tool ordering is set on every thread unconditionally before any LLM call:

```typescript
thread.setToolOrder(
    ADD_REASONING_TOOL
        ? [OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any']
        : ['any', 'any', 'any', 'any'],
);
```

This feature was introduced in commit `36b7103e` and is only supported by `OpenAIAdapter` (when `useStructuredOutputMode` is enabled). The base class `BaseLLMAdapter.supportsToolOrder()` returns `false` by default, and `AnthropicBedrockAdapter` does not override it.

**Step 2: Successful execution with OpenAI.** The chain starts with the OpenAI adapter (`gpt-5-mini-2025-08-07`), which supports tool ordering. Multiple successful calls were made — telemetry shows logs like `"Sending request to OpenAI with 167 messages using structured output mode with tool ordering"`.

**Step 3: Token limit exceeded on OpenAI.** As the conversation grew, it reached 283,670 tokens, exceeding OpenAI's configured 272,000-token limit:

```
ERROR llms/chain.ts:166  Retryable error for gpt-5-mini-2025-08-07:
  400 Input tokens exceed the configured limit of 272000 tokens.
  Your messages resulted in 283670 tokens.
```

The chain retried 3 times (at 15:25:34, 15:25:35, 15:25:39), each failing identically since the token count doesn't decrease between retries.

**Step 4: Fallback to AnthropicBedrockAdapter without clearing toolOrder.** After exhausting retries, the chain in `src/llms/chain.ts` (lines 168-170) advances to the next adapter:

```typescript
this.retryCount = 0;
this.index++;
return await this._chat(thread, options);  // same thread, same toolOrder
```

The chain passes the **exact same `thread` object** — with `toolOrder` still set — to `AnthropicBedrockAdapter`. There is no capability check, no thread cloning, and no `toolOrder` clearing in the fallback path.

**Step 5: AnthropicBedrockAdapter rejects the request.** In `BaseLLMAdapter.chat()` (`base.ts` lines 151-156), the adapter detects the incompatibility:

```typescript
const toolOrder = thread.getToolOrder();
if (toolOrder && !this.supportsToolOrder()) {
    throw new Error(
        `Tool ordering is not supported by ${this.constructor.name}. ` +
        `Only OpenAI adapter currently supports per-turn tool ordering.`
    );
}
```

Since `AnthropicBedrockAdapter` inherits `supportsToolOrder() → false`, this throws a plain `Error`.

**Step 6: Plain Error bypasses further fallback.** The chain's error handling only catches `RetryableLLMError` and `NonRetryableLLMError` for fallback logic. A plain `Error` is re-thrown immediately:

```typescript
if (error instanceof RetryableLLMError) { /* retry/advance */ }
else if (error instanceof NonRetryableLLMError) { /* advance */ }
throw error;  // ← plain Error propagates up, no further fallback
```

The job's retry mechanism re-attempted the entire flow 3 times (at 15:25:40, 16:19:48, 16:39:12), but each attempt hit the same failure since the chain state and thread configuration remained unchanged.

**Alternative hypothesis considered:** "The root cause is the OpenAI token limit being exceeded." This was eliminated because token growth triggering a fallback is an expected scenario — the chain is explicitly designed to handle adapter failures via fallback. The actual bug is that the fallback doesn't work correctly when adapter-specific features like `toolOrder` are set on the thread.

## Fix

**Clear `toolOrder` in the chain's fallback path when the next adapter doesn't support it.** In `src/llms/chain.ts`, before calling the fallback adapter, check whether it supports tool ordering and clear the thread's `toolOrder` if it doesn't:

```typescript
// In _chat(), before calling the next adapter after index increment:
const adapter = this.adapters[this.index];
if (thread.getToolOrder() && !adapter.supportsToolOrder()) {
    thread.setToolOrder(undefined);  // clear incompatible feature
}
result = await adapter.chat(thread, { ... });
```

This fix breaks the causal chain at step 4: when the chain falls back from OpenAI to AnthropicBedrock, the `toolOrder` is cleared, so the guard in `base.ts:151` no longer triggers (`toolOrder` is falsy), and `AnthropicBedrockAdapter` can proceed with the request normally (without tool ordering). The conversation would continue on the fallback adapter without the structured tool ordering constraint, which is a reasonable degradation.

Additionally, `supportsToolOrder()` would need to be exposed as a public method on the adapter interface (or the chain would need another way to check capability) for the chain to perform this pre-flight check.

---