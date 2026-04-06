[Foam Trace ID: 24adc3b1f1dac5e15867971aa9bbee00] ## TL;DR

The `telemetryFromToolResult` function in `query-otel-upgraded.tool.ts` unsafely casts `toolResult.output` (typed `unknown`) to `QueryOtelOutput` without runtime validation, then passes `output.result` directly to `estimateTokens` → `Tiktoken.encode()`. When a tool result's `output` doesn't conform to `QueryOtelOutput` (i.e., `output.result` is not a string), Tiktoken's internal `.match()` call throws `TypeError: text2.match is not a function`. The fix is to add runtime type validation before calling the tokenizer.

## What Broke and Why

During the **EXECUTE phase** of `DeepResearchAgent4.runExecutePhase`, the agent invoked tools via a ~180-second `ai.streamText` call. After streaming completed, the code iterated over tool results:

```typescript
// deep-research-with-skills/index.ts ~lines 377-386
const steps = await result.steps;
const toolCalls = steps.flatMap((step) => step.toolResults);

for (const tc of toolCalls) {
    if (tc.toolName === 'queryOtel') {
        const telemetry = telemetryFromToolResult(tc);
        this.state.telemetry.push(telemetry);
        this.contextManager.addTelemetry(telemetry);
    }
}
```

For a `queryOtel` tool result, `telemetryFromToolResult` was called. This function performs an **unsafe type assertion** with no runtime validation:

```typescript
export function telemetryFromToolResult(toolResult: {
    output: unknown;
    input: unknown;
}): Telemetry {
    const output = toolResult.output as QueryOtelOutput;  // UNSAFE CAST — no runtime check
    const xml = output.result;           // Expected to be string, but not validated
    const tokens = estimateTokens(xml);  // Passes potentially non-string value
    // ...
}
```

The `QueryOtelOutput` type is derived from a Zod schema that declares `result` as `z.string()`, but this schema is **never used for runtime validation** of the tool's `execute()` return value — it only provides TypeScript type inference and LLM schema description. The Vercel AI SDK validates tool **inputs** (LLM arguments) against the `parameters` schema but does **not** validate tool **outputs** against any output schema.

The value `xml` (i.e., `output.result`) was **not a string** at runtime. This non-string value flowed into `estimateTokens`:

```typescript
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return getEncoder().encode(text).length;
}
```

The `if (!text) return 0` guard only catches falsy values (`null`, `undefined`, `""`, `0`). If `text` is a **truthy non-string value** (e.g., an object or non-empty array), it passes the guard and reaches `Tiktoken.encode()`. Tiktoken's `encode` method internally calls `text.match(regex)` to tokenize the input. Since the value was not a string, JavaScript threw `TypeError: text2.match is not a function` (where `text2` is the minified/bundled variable name for the `text` parameter).

The telemetry confirms this causal chain via the stack trace:
- `DeepResearchAgent4.runExecutePhase` (line 451849)
- → `telemetryFromToolResult` (line 446938)
- → `estimateTokens` (line 446228)
- → `_Tiktoken.encode` (line 446129) — crash site

The error was marked as `handled: true` but still terminated the agent run after ~4.7 minutes of execution.

**Why was `output.result` not a string?** The most likely cause is that the `queryOtel` tool's `execute()` function returned a non-conforming object in an error/edge-case path (e.g., a ClickHouse query failure where the catch block returns an object without a proper string `result` field). The Zod output schema provides no runtime protection since it's never `.parse()`'d against the actual return value. An alternative possibility is that the AI SDK wrapped or transformed the tool result in an unexpected way during an error condition.

**Alternative hypothesis considered and eliminated:** The AI SDK serializing/deserializing the tool output and changing its type. The AI SDK preserves the raw JavaScript return value from `execute()` in `step.toolResults` — it only serializes for the LLM conversation context, not for the programmatic access path. The earlier successful telemetry processing during the HYPOTHESIZE phase (at 01:54:53.924, producing 3846 tokens) confirms the normal path works when `output.result` is a proper string.

## Fix

Add runtime type validation in `estimateTokens` to guard against non-string inputs:

```typescript
export function estimateTokens(text: string): number {
    if (!text || typeof text !== 'string') return 0;
    return getEncoder().encode(text).length;
}
```

**Additionally**, add runtime validation in `telemetryFromToolResult` to validate the tool output before accessing its fields, either via the existing Zod schema or a manual check:

```typescript
export function telemetryFromToolResult(toolResult: {
    output: unknown;
    input: unknown;
}): Telemetry {
    const parsed = outputSchema.safeParse(toolResult.output);
    if (!parsed.success) {
        log().warn(`[telemetryFromToolResult] invalid tool output: ${parsed.error.message}`);
        return { id: crypto.randomUUID(), query: '', xml: '', tokens: 0 };
    }
    const output = parsed.data;
    const xml = output.result;
    const tokens = estimateTokens(xml);
    // ...
}
```

**Why this fixes the root cause:** The `typeof text !== 'string'` check in `estimateTokens` directly prevents non-string values from reaching `Tiktoken.encode()`, breaking the causal chain at step 3 (the unvalidated pass-through). The `outputSchema.safeParse()` in `telemetryFromToolResult` breaks the chain at step 2 (the unsafe cast), ensuring the tool output conforms to `QueryOtelOutput` before any field access. Together, these eliminate both the root cause (missing runtime validation of the unsafe cast) and the proximate cause (non-string reaching the tokenizer).

---
