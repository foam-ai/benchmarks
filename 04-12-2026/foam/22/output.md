[Foam Trace ID: be35294a25cdc6cee079acf7623fdf4f] ## TL;DR

`telemetryFromToolResult` unsafely casts `toolResult.output as QueryOtelOutput` with no runtime validation, allowing `output.result` to be a non-string (either a raw JSON array from the non-upgraded `createQueryOtelTool`, or an error object when the upstream `ai.streamText` call fails). Passing that non-string into `estimateTokens` → `_Tiktoken.encode()` causes the library's internal `text2.match(...)` call to crash with `TypeError: text2.match is not a function`. The fix is to add a runtime type guard that stringifies `output.result` before passing it to `estimateTokens`.

---

## What Broke and Why

### Trigger: EXECUTE phase LLM call exhausts retries

During eval run `foam-drain3-path-error`, the 180-second EXECUTE phase `ai.streamText` call to `claude-opus-4-6` (span s6) failed with:

```
AI_RetryError: maxRetriesExceeded on api.anthropic.com/v1/messages
  (model: claude-opus-4-6, max_tokens: 128000)
```

This exception propagated back through `runExecutePhase` in `deep-research-with-skills/index.ts`, which collected tool results from `step.toolResults` — now containing a structured AI SDK error object rather than a successful `QueryOtelOutput` payload.

### The unsafe cast in `telemetryFromToolResult`

Inside `query-otel-upgraded.tool.ts` (~line 410), `telemetryFromToolResult` processes each `queryOtel` tool call result:

```typescript
export function telemetryFromToolResult(toolResult: {
    output: unknown;
    input: unknown;
}): Telemetry {
    const output = toolResult.output as QueryOtelOutput;  // ← pure compile-time assertion, no runtime check
    const xml = output.result;                            // ← can be non-string at runtime
    const tokens = estimateTokens(xml);                  // ← crashes if xml is not a string
    ...
}
```

The `as QueryOtelOutput` cast is a TypeScript compile-time-only assertion. There is no `outputSchema.parse()` or `typeof` guard applied at runtime. `QueryOtelOutput` is defined with `result: z.string()`, but that Zod schema is never invoked to validate the actual value.

### Two distinct paths that produce a non-string `output.result`

**Path 1 — Wrong tool version:** `runExecutePhase` collects results from `createQueryOtelTool` (the non-upgraded version used by the skills agent), whose output schema declares `result: z.unknown()`. This tool's `executeQuery()` returns:

```typescript
const rows = await result.json();  // rows is an Array<object>
return { result: rows, rowCount, durationMs, sql };
//               ^^^^ raw array, never stringified
```

So `output.result` is a `Record<string, unknown>[]` JavaScript array, not a string.

**Path 2 — Error object propagation (what happened here):** When the Anthropic API call exhausted retries, the AI SDK surfaced an `AI_RetryError` object. `runExecutePhase` passed this through to `telemetryFromToolResult`, where `output.result` resolved to either `undefined` or a structured error object — neither of which is a string.

### The crash in `_Tiktoken.encode`

```typescript
// tokens.ts
export function estimateTokens(text: string): number {
    if (!text) return 0;               // ← falsy guard does NOT catch objects or arrays
    return getEncoder().encode(text).length;  // ← encode() crashes here
}
```

Note: the `if (!text) return 0` guard only catches `null`, `undefined`, `0`, `""`, and `false`. An array (`[]`) or object (`{}`) is truthy, so the guard is bypassed and the non-string value reaches `getEncoder().encode(text)`.

Inside `js-tiktoken`, `_Tiktoken.encode()` assigns the argument to internal variable `text2` and calls:

```
text2.match(...)  // expects String.prototype.match — fails on arrays/objects
```

Result: **`TypeError: text2.match is not a function`** at timestamp `2026-03-18T01:59:13.350Z`.

### Full causal chain

```
AI_RetryError: maxRetriesExceeded (span s6, 01:56:13)
  → runExecutePhase receives error object in step.toolResults
    → telemetryFromToolResult(tc) called with tc.output = non-string
      → unsafe `as QueryOtelOutput` cast — no runtime validation
        → output.result is non-string (array or error object)
          → estimateTokens(xml) called with non-string
            → if (!text) guard bypassed (truthy non-string)
              → _Tiktoken.encode(text2) called
                → text2.match(...) → TypeError: text2.match is not a function
```

---

## Fix

**Add a runtime type guard in `telemetryFromToolResult` before calling `estimateTokens`:**

```typescript
export function telemetryFromToolResult(toolResult: {
    output: unknown;
    input: unknown;
}): Telemetry {
    const output = toolResult.output as QueryOtelOutput;
    const rawResult = output?.result;

    // Guard: stringify non-string result values before token estimation
    const xml = typeof rawResult === 'string'
        ? rawResult
        : JSON.stringify(rawResult ?? '');

    const tokens = estimateTokens(xml);
    ...
}
```

Alternatively, strengthen `estimateTokens` itself as a defensive layer:

```typescript
export function estimateTokens(text: unknown): number {
    if (!text) return 0;
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    return getEncoder().encode(str).length;
}
```

**Why this breaks the causal chain:** With this fix, `output.result` is always coerced to a string before reaching `_Tiktoken.encode()`. The `text2.match(...)` call inside `js-tiktoken` will always receive a native JavaScript string regardless of whether the upstream tool returned a raw array (Path 1) or an error object was propagated (Path 2). The TypeError can no longer be triggered through either path.

**Secondary recommendation:** Replace the unsafe `as QueryOtelOutput` cast with a `outputSchema.safeParse()` call so mismatched tool results are caught early and handled explicitly rather than silently mistyped:

```typescript
const parsed = outputSchema.safeParse(toolResult.output);
if (!parsed.success) {
    // handle gracefully — log and return empty telemetry
    return emptyTelemetry();
}
const xml = parsed.data.result;
```

---
