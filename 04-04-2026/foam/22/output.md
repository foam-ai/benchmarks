## TL;DR

`DeepResearchAgent4` uses the **old** `createQueryOtelTool` (which returns `result` as a raw JavaScript array/object) but processes those results with `telemetryFromToolResult` from the **upgraded** tool module, which assumes `result` is always a string. When `estimateTokens()` receives the non-string array, it passes it to `js-tiktoken`'s `encode()`, which internally calls `.match()` on the non-string argument — crashing with `TypeError: text2.match is not a function`. The fix is to make `DeepResearchAgent4` use the upgraded tool end-to-end, or to add a `typeof text !== 'string'` guard in `estimateTokens`.

---

## What Broke and Why

### Causal Chain

**Step 1 — Tool/helper mismatch introduced during migration**

In `/repo/mewtwo/src/agents/deep-research-with-skills/index.ts`, `DeepResearchAgent4` registers its tools and then processes their results:

```typescript
// Tool REGISTRATION (line 315) — uses the OLD tool
const tools = {
    queryOtel: createQueryOtelTool(this.toolCtx),   // ← from query-otel.tool.ts
    ...
};

// Tool RESULT PROCESSING (line ~377) — uses the UPGRADED tool's helper
for (const tc of toolCalls) {
    if (tc.toolName === 'queryOtel') {
        const telemetry = telemetryFromToolResult(tc);  // ← from query-otel-upgraded.tool.ts
        ...
    }
}
```

Both symbols are imported from the same barrel file (`../tools/index.ts`), but they resolve to different source files:
```typescript
export { createQueryOtelTool }         from './query-otel.tool';           // OLD
export { telemetryFromToolResult }     from './query-otel-upgraded.tool';  // UPGRADED
```

This is a silent mismatch — TypeScript happily compiles it because both tools share the `QueryOtelOutput` type name, but the underlying Zod schemas differ critically.

**Step 2 — The old tool returns `result` as a non-string**

`query-otel.tool.ts` defines `result: z.unknown()` and returns raw JavaScript values:
```typescript
// Happy path (line 139)
return { result: rows, rowCount, durationMs, sql };
// rows = await result.json() — a JS array of objects, NOT a string

// Error paths (lines 205, 218)
return { result: { error: msg, fix: '...' }, sql };  // plain object
return { result: { error: msg }, sql };               // plain object
```

**Step 3 — The upgraded helper assumes `result` is always a string**

`telemetryFromToolResult` in `query-otel-upgraded.tool.ts` casts the output without any runtime validation:
```typescript
export function telemetryFromToolResult(toolResult: {
    output: unknown;
    input: unknown;
}): Telemetry {
    const output = toolResult.output as QueryOtelOutput;  // pure TS cast, zero runtime check
    const xml = output.result;   // typed as string, but actually an array/object at runtime
    const tokens = estimateTokens(xml);   // passes the array to tiktoken
    ...
}
```

The `as QueryOtelOutput` cast is a TypeScript compile-time assertion only. No `outputSchema.safeParse()` or `outputSchema.parse()` call exists in this function, so the Zod `z.string()` constraint on `result` is never enforced at runtime.

**Step 4 — The falsy guard in `estimateTokens` does not catch truthy non-strings**

```typescript
export function estimateTokens(text: string): number {
    if (!text) return 0;   // only catches "", null, undefined, 0, false
    return getEncoder().encode(text).length;   // crashes for arrays/objects
}
```

A truthy array like `[{ traceId: "...", ... }]` passes the `!text` guard and is handed directly to `getEncoder().encode()`.

**Step 5 — Tiktoken crashes**

`js-tiktoken`'s `_Tiktoken.encode()` method (internal minified name `text2`) calls `.match()` on its argument expecting a string:
```
_Tiktoken.encode → text2.match(...)  →  TypeError: text2.match is not a function
```

The crash is thrown, propagates up through `runExecutePhase → execute → run → runDeepResearch5PhasesAgent4`, and is caught by the Braintrust eval harness, marking the entire eval run as failed:

```
[01:59:13] ERROR  DeepResearchAgent Run failed  runId=78e4f16f...  error="text2.match is not a function"  durationMs=268740
```

### Evidence Summary

| Evidence | Source |
|---|---|
| Stack trace: `_Tiktoken.encode ← estimateTokens ← telemetryFromToolResult ← runExecutePhase` | Span `a1a281edb7fcd33e` telemetry |
| `createQueryOtelTool` resolves to `query-otel.tool.ts` (old) | LSP + `tools/index.ts` barrel exports |
| `telemetryFromToolResult` resolves to `query-otel-upgraded.tool.ts` | LSP + `tools/index.ts` barrel exports |
| Old tool: `result: rows` (raw array) | `query-otel.tool.ts` line 139 |
| Upgraded tool: `result: JSON.stringify(rows)` (always string) | `query-otel-upgraded.tool.ts` line ~396 |
| `estimateTokens` guard `if (!text)` skips truthy arrays | `tokens.ts` line 19–21 |
| Error is `handled: true`; HYPOTHESIZE and PLAN phases succeeded | Span attributes + log timeline |

### Alternative Hypothesis Ruled Out

**Could the upgraded tool itself produce a non-string `result`?** No — `JSON.stringify()` always returns a string, and the upgraded tool's error-catch wrapper also returns `JSON.stringify({ error: ... })` (a string). Confirmed by code inspection.

---

## Fix

### Root Cause Fix — Use the upgraded tool end-to-end in `DeepResearchAgent4`

**File:** `/repo/mewtwo/src/agents/deep-research-with-skills/index.ts`

Replace the old `createQueryOtelTool` import and usage with `createQueryOtelUpgradedTool`:

```typescript
// Before
import { createQueryOtelTool, ..., telemetryFromToolResult } from '../tools';

// After
import { createQueryOtelUpgradedTool, ..., telemetryFromToolResult } from '../tools';

// In tool registration (line 315)
const tools = {
    queryOtel: createQueryOtelUpgradedTool(this.toolCtx),  // ← upgraded tool
    ...
};
```

This breaks the causal chain at **Step 2**: the upgraded tool always serializes its result with `JSON.stringify()`, so `output.result` is always a string when it reaches `telemetryFromToolResult`. The type contract that `telemetryFromToolResult` assumes (`result: string`) is then actually enforced at the point of output construction.

### Secondary Defensive Fix — Guard against non-strings in `estimateTokens`

**File:** `/repo/mewtwo/src/agents/utils/context-management/tokens.ts`

```typescript
export function estimateTokens(text: string): number {
    if (!text || typeof text !== 'string') return 0;  // ← add typeof check
    return getEncoder().encode(text).length;
}
```

This prevents any future caller from crashing the process if a non-string is accidentally passed. It does not fix the root cause (the tool mismatch), but it makes the failure mode graceful (returns 0 tokens instead of throwing) and protects all 37 call sites.

### Optional Architectural Fix — Validate at the data boundary in `telemetryFromToolResult`

**File:** `/repo/mewtwo/src/agents/tools/query-otel-upgraded.tool.ts`

```typescript
export function telemetryFromToolResult(toolResult: { output: unknown; input: unknown }): Telemetry {
    const parsed = outputSchema.safeParse(toolResult.output);
    if (!parsed.success) {
        // Return safe default rather than crashing
        return { xml: '', tokens: 0 };
    }
    const xml = parsed.data.result;  // now guaranteed to be a string
    const tokens = estimateTokens(xml);
    ...
}
```

This enforces the Zod schema at the runtime boundary where `unknown` data enters typed code, following the defensive programming principle that `as T` casts on `unknown` inputs are always unsafe.


---