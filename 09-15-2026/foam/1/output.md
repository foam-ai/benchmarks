[Foam Trace ID: af71e6d09959b7554a7ba006ba44cb27] ## TL;DR

OpenAI hit its input token limit at ~273K tokens, the thread fell back to `AnthropicBedrockAdapter`, which rejects the `toolOrder` option configured on the issue-solver thread; `BaseLLMAdapter` throws on every retry and `TerminalVelocityRetry` surfaces the last error.

## What Broke and Why

**Observed error:** `TerminalVelocityRetryableError: toolOrder is not supported by AnthropicBedrockAdapter`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** The conversation thread accumulated 273,263 input tokens with `gpt-5-mini-2025-08-07`, triggering the provider fallback path.

**2.** The issue-solver thread sets `toolOrder`, which only the OpenAI adapter honours; `BaseLLMAdapter.validateOptions` throws for unsupported options at runtime.

**3.** All three retry attempts fall back to the same adapter with the same options, so each fails identically before any request is sent.

## Fix

- Strip `toolOrder` (or map it to an equivalent) when falling back to a non-OpenAI adapter.
- Truncate or summarise the thread before it reaches the OpenAI input limit so the fallback is rarely needed.


---
