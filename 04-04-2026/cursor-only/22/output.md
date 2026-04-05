## TL;DR

`telemetryFromToolResult()` passes a non-string value (array/object from the basic `queryOtel` tool) into `estimateTokens()` → `js-tiktoken`'s `Tiktoken.encode()`, which calls `.match()` on it. Esbuild scope-hoisting renames the `text` parameter to `text2` in the bundle, producing `TypeError: text2.match is not a function`.

## What Broke and Why

The error originates from a **type mismatch between two versions of the queryOtel tool** and a shared `telemetryFromToolResult()` function that assumes the tool always returns `result` as a string.

**Two queryOtel tools exist with incompatible `result` types:**

1. **Basic tool** (`mewtwo/src/agents/tools/query-otel.tool.ts`): Its output schema declares `result: z.unknown()` (line 16). On success, it returns `result: rows` where `rows = await result.json()` — a **parsed JSON array of objects**, not a string (line 124, 139). On error, it returns `result: { error: msg }` — an **object** (lines 204-220).

2. **Upgraded tool** (`mewtwo/src/agents/tools/query-otel-upgraded.tool.ts`): Its output schema declares `result: z.string()` (line 25). It correctly stringifies results with `JSON.stringify(rows)` before returning (line 382, 396).

**The `telemetryFromToolResult()` function (lines 404-419 of the upgraded tool file) is shared across agents that use either tool.** It does:

```typescript
const output = toolResult.output as QueryOtelOutput; // unsafe cast
const xml = output.result;    // expects string, gets array/object from basic tool
const tokens = estimateTokens(xml);  // passes non-string to tiktoken
```

The `as QueryOtelOutput` cast uses the *upgraded* tool's type (where `result: string`), silently masking the type mismatch at compile time.

**Agents using the basic tool + `telemetryFromToolResult()`:**
- `deep-research-with-skills/index.ts` (line 316: `createQueryOtelTool`, line 382: `telemetryFromToolResult(tc)`)
- `deep-research-with-context-management/index.ts` (line 315: `createQueryOtelTool`, line 343: `telemetryFromToolResult(tc)`)

Both agents register the basic tool as `queryOtel`, iterate over tool results, and call `telemetryFromToolResult(tc)` for each `queryOtel` result — feeding the non-string `result` into the function.

**The crash site — `estimateTokens()` → `js-tiktoken`:**

`estimateTokens()` (in `tokens.ts`) has only a falsy guard: `if (!text) return 0`. Arrays and objects are truthy, so they pass through. It calls `getEncoder().encode(text)`, which reaches `js-tiktoken`'s `Tiktoken.encode()` method. Inside that method (in `node_modules/js-tiktoken/dist/chunk-VL2OQCWN.js`, line 99):

```javascript
const specialMatch = text.match(disallowedSpecialRegex);
```

Since `text` is an array/object (not a string), it has no `.match()` method → `TypeError`.

**Why `text2` instead of `text`:**

The eval runner (`mewtwo/src/bin/eval.ts`, line 109) invokes `yarn braintrust eval` with `--external-packages=*`. The Braintrust CLI uses esbuild to bundle the eval entry point. The `*` flag is interpreted literally (escaped to `\*`) and does not effectively externalize bare specifier imports, so `js-tiktoken` gets bundled into a single file. Esbuild's scope-hoisting merges all ESM modules into one scope, renaming conflicting top-level variables. The `text` parameter in `Tiktoken.encode()` collides with other top-level `text` bindings (e.g., from the `ai` SDK) and gets renamed to `text2` in the bundled output.

**Causality chain:**
1. Basic `queryOtel` tool returns `result: rows` (an array from ClickHouse JSON response)
2. Deep-research agent collects tool results and calls `telemetryFromToolResult(tc)`
3. `telemetryFromToolResult` casts `tc.output` as `QueryOtelOutput` (upgraded type, expects `result: string`) — no runtime validation
4. `output.result` is actually an array/object, assigned to `xml`
5. `estimateTokens(xml)` — falsy guard `if (!text)` doesn't catch truthy non-strings
6. `getEncoder().encode(xml)` reaches `js-tiktoken`'s `Tiktoken.encode()`
7. Inside the esbuild bundle, `text` is renamed to `text2` due to scope hoisting
8. `text2.match(disallowedSpecialRegex)` throws `TypeError: text2.match is not a function`
9. Error propagates to `BaseAgent.run()` catch block, which calls `foam.captureException(error)` with `handled: true`

## Fix

**1. Add runtime type validation in `telemetryFromToolResult()`** (`mewtwo/src/agents/tools/query-otel-upgraded.tool.ts`):

```typescript
export function telemetryFromToolResult(toolResult: {
	output: unknown;
	input: unknown;
}): Telemetry {
	const output = toolResult.output as QueryOtelOutput;
	const xml = typeof output.result === 'string'
		? output.result
		: JSON.stringify(output.result);
	const tokens = estimateTokens(xml);
	const id = crypto.randomUUID();
	const query = typeof output.sql === 'string' ? output.sql : '';

	log().info(
		`[telemetryFromToolResult] created telemetry telemetryId=${id} tokens=${tokens} xmlChars=${xml.length} queryPreview=${query.replace(/\s+/g, ' ').slice(0, 100)}`,
	);

	return { id, query, xml, tokens };
}
```

**2. Harden `estimateTokens()` with a typeof guard** (`mewtwo/src/agents/utils/context-management/tokens.ts`):

```typescript
export function estimateTokens(text: string): number {
	if (typeof text !== 'string' || !text) return 0;
	return getEncoder().encode(text).length;
}
```

**3. Align the basic tool's `result` type** (`mewtwo/src/agents/tools/query-otel.tool.ts`): Change the success path to stringify `rows` before returning, matching the upgraded tool's contract:

```typescript
// Line 139: change from
return { result: rows, rowCount, durationMs: queryDurationMs, sql };
// to
return { result: JSON.stringify(rows), rowCount, durationMs: queryDurationMs, sql };
```

And change error paths (lines 204, 217) similarly:

```typescript
// Line 217-220: change from
return { result: { error: msg }, sql };
// to
return { result: JSON.stringify({ error: msg }), sql };
```
