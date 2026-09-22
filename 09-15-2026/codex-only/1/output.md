## TL;DR

OpenAI hit its input token limit at ~273K tokens, the thread fell back to `AnthropicBedrockAdapter`, which rejects the `toolOrder` option configured on the issue-solver thread; `BaseLLMAdapter` throws on every retry and `TerminalVelocityRetry` surfaces the last error.

## What Broke and Why

**Observed error:** `TerminalVelocityRetryableError: toolOrder is not supported by AnthropicBedrockAdapter`

### Causal Chain

**1.** The conversation thread accumulated 273,263 input tokens with `gpt-5-mini-2025-08-07`, triggering the provider fallback path.

**2.** The issue-solver thread sets `toolOrder`, which only the OpenAI adapter honours; `BaseLLMAdapter.validateOptions` throws for unsupported options at runtime.

**3.** All three retry attempts fall back to the same adapter with the same options, so each fails identically before any request is sent.

## Fix

- Strip `toolOrder` (or map it to an equivalent) when falling back to a non-OpenAI adapter.
- Truncate or summarise the thread before it reaches the OpenAI input limit so the fallback is rarely needed.

---

## Metrics

**Performance:**
- Total latency: 573 seconds
- Token usage: 178,765 + 9,698 = 188,463 tokens

**Tool Usage:**
- Top 3 most-used tools: shell, apply_patch, read_file
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
