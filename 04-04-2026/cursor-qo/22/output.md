## TL;DR
Commit `54dd1780` changed the `queryOtel` tool to return raw ClickHouse row objects (`z.unknown()`) instead of pre-serialized JSON strings (`z.string()`), causing the AI SDK's internal text-processing pipeline to call `.match()` on a non-string value during agent execution.

## What Broke and Why

The error `TypeError: text2.match is not a function` occurred during the eval task `foam-drain3-path-error` running the `deep-research-5-phases-skills` experiment (DeepResearchAgent with Claude Opus 4.6 and Anthropic code_execution skills).

**Root cause:** Commit `54dd1780` ("[FOA-1767] fix(query-otel): return raw ClickHouse rows instead of double-serialized JSON") made two critical changes to `mewtwo/src/agents/tools/query-otel.tool.ts`:

1. **Output schema changed:** `result: z.string()` → `result: z.unknown()`
2. **Return value changed:** `return { result: output, ... }` (where `output` was an XML string from `processTelemetry()`) → `return { result: rows, ... }` (where `rows` is a raw array of ClickHouse row objects)

Previously, the tool compressed telemetry data into an XML string and returned it as a string. After the change, it returns raw JavaScript objects/arrays directly from ClickHouse's `result.json()`.

When the AI SDK (`ai@6.0.116`) processes tool results internally — particularly through its text content handling and response processing pipeline — it expects string values in certain codepaths. The bundled variable `text2` in `ai/dist/index.mjs` is assigned from content parts that may include serialized tool results. When `text2` ends up as an object (the raw ClickHouse rows) instead of a string, calling `.match()` on it throws `TypeError: text2.match is not a function`.

The error was **handled** (caught by the `runExperimentTask` catch block in `index.eval.ts`), which called `foam.captureException(error)` and returned a `[FAILED]` message, meaning the eval case scored 0 but didn't crash the eval run.

**Timeline from trace (`62fe34100cad8403bdbbe5a7c93becf0`):**
- `01:54:43` — Eval task span starts
- `01:54:53` — First `ai.streamText` call (~37s, Claude Opus 4.6 hypothesize phase)
- `01:56:37` — Docker exec operations (execute phase with code_execution skills)
- `01:59:13` — `TypeError: text2.match is not a function` thrown and captured
- Parent span: `05272b8d6fcfbd6f` (eval task for `foam-drain3-path-error`)

## Fix

**Immediate fix:** Ensure the `queryOtel` tool always returns a string result by JSON-serializing the raw rows before returning:

```typescript
// In mewtwo/src/agents/tools/query-otel.tool.ts, executeQuery function:
return { result: JSON.stringify(rows), rowCount, durationMs: queryDurationMs, sql };
```

Or revert the output schema to `z.string()` and wrap the result:

```typescript
export const outputSchema = z.object({
    result: z.string().describe('The result of the ClickHouse SQL query as JSON.'),
    // ...
});
```

**Better fix:** Keep `z.unknown()` for flexibility but add explicit serialization in the tool's execute function to ensure the result is always a string when passed through the AI SDK's tool result pipeline:

```typescript
return {
    result: typeof rows === 'string' ? rows : JSON.stringify(rows, null, 2),
    rowCount,
    durationMs: queryDurationMs,
    sql,
};
```

This preserves the intent of returning "raw" data while ensuring type safety in the AI SDK's internal processing.

---
