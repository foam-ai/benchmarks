## TL;DR
Elasticsearch `arg_N` fields in the logging transport accept heterogeneous types (numbers, strings, booleans), causing `document_parsing_exception` when dynamic mapping locks a field to `long` and a subsequent log entry sends a string.

## What Broke and Why

The error is a `document_parsing_exception` thrown by Elasticsearch when the `ElasticsearchTransport` attempts to index a log document. The causality chain is:

1. **Elasticsearch dynamic mapping**: When Elasticsearch encounters a new field for the first time, it infers the type and creates a mapping. Once `arg_0` is mapped as `long` (from a log entry where the first non-object argument was a number), that mapping is locked for the lifetime of the index.

2. **Type-heterogeneous `arg_N` fields**: The `_processNonObjectArg` method in `mewtwo/src/elasticsearch/transport.ts` (line 299-314) creates fields named `arg_0`, `arg_1`, etc. for non-object log arguments. Critically, it stores values with their **original JavaScript types** — numbers stay numbers, strings stay strings, booleans stay booleans:

   ```typescript
   // line 313 — stores the raw value without type coercion
   baseFields[key] = arg instanceof Date ? arg.toISOString() : arg;
   ```

3. **The conflict**: Log calls across the codebase produce different types for the same positional `arg_N` field. For example:
   - One log entry might have `arg_0 = 42` (number → Elasticsearch maps as `long`)
   - A later log entry has `arg_0 = "log().info('Creating worktree', ...)"` (string → Elasticsearch rejects)

4. **How the source code string appears**: The `createLogObj` function in `logging.ts` (line 431-458) strips the first string argument as `message` and stores remaining args in `logObj.args`. Additionally, `setTransport` in `logging.ts` (line 226-236) attaches a transport callback directly to `globalLogger` via `globalLogger.attachTransport(...)`. While the proxy in `log()` intercepts logging methods and routes through `processLogCall` (which creates clean LogObj instances), tslog's `ILogObj` uses indexed numeric properties (`0`, `1`, etc.) that contain the arguments — and tslog's pretty mode can include source code context. If the `globalLogger` transport callback fires (through initialization race conditions or edge cases), the tslog-processed `ILogObj` flows to `sendToElasticsearch`, where `_processIndexedProperties` processes numeric keys, and the args processing creates `arg_N` fields with the raw values.

5. **The crash**: The Elasticsearch client rejects the document at index time: `[1:114] failed to parse field [arg_0] of type [long]` — the string `"log().info('Creating worktree', { repoOwner, repoName, gitSha, worktreePath });"` cannot be parsed as a `long`.

## Fix

**Primary fix — Coerce all `arg_N` values to strings in `_processNonObjectArg`** (`mewtwo/src/elasticsearch/transport.ts`, line 299-314):

```typescript
private _processNonObjectArg(baseFields: Record<string, unknown>, arg: unknown, i: number) {
    const key = `arg_${i}`;
    if (typeof arg === 'object' && arg !== null) {
        try {
            if (Array.isArray(arg) && arg.length > 100) {
                baseFields[key] = `Array with ${arg.length} items`;
            } else {
                baseFields[key] = safeStringify(arg);
            }
        } catch (_) {
            baseFields[key] = '[Complex object]';
        }
    } else {
        baseFields[key] = arg instanceof Date ? arg.toISOString() : String(arg);
    }
}
```

The key changes:
- **Line 306**: Change `baseFields[key] = arg` → `baseFields[key] = safeStringify(arg)` — serialize arrays/objects to JSON strings instead of passing raw objects that could have inconsistent nested types.
- **Line 313**: Change `arg instanceof Date ? arg.toISOString() : arg` → `arg instanceof Date ? arg.toISOString() : String(arg)` — convert all primitives (numbers, booleans, strings) to strings, ensuring `arg_N` fields always have a consistent `text`/`keyword` mapping in Elasticsearch.

**Secondary fix — Remove the unused `globalLogger.attachTransport` call** (`mewtwo/src/logging.ts`, line 231-234):

The transport attachment on `globalLogger` is dead code in the normal path (the proxy intercepts all logging methods and sends to Elasticsearch via `sendToTransports` directly). However, it creates a risk of double-sending and type-inconsistent documents if `globalLogger` is ever invoked directly. Remove the `globalLogger.attachTransport(...)` call from `setTransport` to eliminate this risk entirely.

---
