## TL;DR
The AnthropicBedrockAdapter doesn't support per-turn tool ordering, but the IssueSolver attempts to use it when ANTHROPIC_MODEL is tried first in the agent chain fallback sequence.

## What Broke and Why

### Root Cause Analysis

The error occurs in `/app/src/llms/adapters/base.ts` at lines 151-156:

```
if (toolOrder && !this.supportsToolOrder()) {
    throw new Error(
        `Tool ordering is not supported by ${this.constructor.name}. ` +
            `Only OpenAI adapter currently supports per-turn tool ordering.`,
    );
}
```

### Causality Chain

1. **IssueSolver sets tool ordering** (`src/services/issue-solver/issue-solver.ts:195-199`):
   - The issue solver explicitly calls `thread.setToolOrder([OUTPUT_REASONING_TOOL_NAME, 'any', 'any', 'any'])`
   - This is used to force structured reasoning before permitting multiple tool calls

2. **Agent Chain attempts multiple adapters** (`src/llms/role-chains.ts:62-76`):
   - `createIssueSolverAgentChain()` creates a chain that tries:
     - First: `OPENAI_MODEL` with fallbacks to `[ANTHROPIC_MODEL, GEMINI_MODEL]`
     - Then: `ANTHROPIC_MODEL` with fallback to `[GEMINI_MODEL]`
   - Where `ANTHROPIC_MODEL = CLAUDE_4_BEDROCK`

3. **AnthropicBedrockAdapter doesn't support tool ordering**:
   - `AnthropicBedrockAdapter` extends `BaseLLMAdapter` but doesn't override `supportsToolOrder()`
   - The base implementation returns `false` by default (line 49 in base.ts)
   - When the adapter reaches the chat method with a thread that has `toolOrder` set, it fails

4. **OpenAIAdapter correctly supports it**:
   - `OpenAIAdapter.supportsToolOrder()` returns `true` when `useStructuredOutputMode` is enabled (line 209-211 in openai.ts)
   - It implements the structured output format generation for tool ordering (lines 813-948 in openai.ts)

### Why This Matters

Tool ordering is a feature that constrains the LLM to call tools in a specific sequence (e.g., first call the "reasoning" tool, then "any" remaining tools). This is implemented in OpenAI's structured output mode using JSON schemas with numbered tool call slots. The AnthropicBedrockAdapter uses standard tool definitions without this structured ordering capability.

---

## Fix

**Implement `supportsToolOrder()` and structured output support in AnthropicBedrockAdapter:**

The immediate fix is to make AnthropicBedrockAdapter reject toolOrder requests gracefully **before** attempting the LLM call, OR implement proper tool ordering support.

### Option 1: Quick Fix (Disable tool ordering for Anthropic)

Override `supportsToolOrder()` in `AnthropicBedrockAdapter` to return `false` explicitly, and let the chain fallback to OpenAI or Gemini:

```typescript
// In AnthropicBedrockAdapter (src/llms/adapters/anthropic-bedrock.ts)
protected supportsToolOrder(): boolean {
    return false;
}
```

This is the minimal change - the agent chain will simply skip AnthropicBedrockAdapter if toolOrder is required and fall through to the next adapter.

### Option 2: Proper Fix (Implement tool ordering for Anthropic)

Implement structured output format support in AnthropicBedrockAdapter similar to OpenAIAdapter:

1. Override `supportsToolOrder()` to return `true`
2. Modify `convertThreadToCreateMessageParams()` to check for `thread.getToolOrder()`
3. When tool ordering is detected, convert the tool order constraints into Anthropic's tool format (possibly using tool choice or a custom format)
4. Update `makeLLMCall()` to parse the response according to the tool order schema

However, Anthropic's Bedrock SDK may not have native support for this level of control, so Option 1 is recommended.

---
