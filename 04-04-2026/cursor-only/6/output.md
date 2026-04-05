## TL;DR
The `_processNonObjectArg` method in `ElasticsearchTransport` stores `arg_N` fields with their native JavaScript types (number, string, boolean, array), causing Elasticsearch dynamic mapping conflicts when different log calls produce the same `arg_N` field with different types.

## What Broke and Why

The `ElasticsearchTransport.sendToElasticsearch` method in `mewtwo/src/elasticsearch/transport.ts` processes log arguments through `_processNonObjectArg` (line 299), which creates document fields named `arg_0`, `arg_1`, etc. for non-object arguments. Crucially, this method preserves the native JavaScript type of each value:

```typescript
private _processNonObjectArg(baseFields: Record<string, unknown>, arg: unknown, i: number) {
    const key = `arg_${i}`;
    // ...
    } else {
        baseFields[key] = arg instanceof Date ? arg.toISOString() : arg;
    }
}
```

When `arg` is a number (e.g., `42`), `arg_0` is stored as a number. When `arg` is a string, `arg_0` is stored as a string. Elasticsearch uses dynamic mapping: the first document indexed into `mewtwo-logs-2025.12.v2.0.1` that contains an `arg_0` with a numeric value causes ES to map `arg_0` as type `long`. All subsequent documents in that index must then have `arg_0` as a `long`.

The causality chain:
1. Some log call sends a document where `arg_0` is a number (e.g., `log().info('Some message', 42)`). ES dynamically maps `arg_0` as `long`.
2. A subsequent log call sends a document where `arg_0` is a string — in this case, the string value `"log().info('Creating worktree', { repoOwner, repoName, gitSha, worktreePath });"`.
3. ES rejects the document with `document_parsing_exception: failed to parse field [arg_0] of type [long]`.
4. The failed document enters the retry loop in `processQueue` (line 108), retrying up to `maxRetries` (3) times before being dropped.

The commit at this SHA (`79390570`, "Fix logs (#97)") converted 74 log calls from `log().error('Message', error)` to `log().error('Message', { error })`, wrapping raw second arguments in objects so they go through `_processObjectArg` (which merges keys into the document root) rather than `_processNonObjectArg` (which creates `arg_N` fields). This was the right direction but didn't address the fundamental design flaw: any remaining or future log call that passes a non-object as a secondary argument can still produce `arg_N` fields with conflicting types.

## Fix

Convert all `arg_N` values to strings in `_processNonObjectArg` to ensure consistent Elasticsearch field typing:

```typescript
// mewtwo/src/elasticsearch/transport.ts

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
    } else if (arg instanceof Date) {
        baseFields[key] = arg.toISOString();
    } else {
        baseFields[key] = String(arg);
    }
}
```

This ensures `arg_N` fields are always strings, eliminating the ES dynamic mapping conflict. The change also converts array args to their JSON string representation for consistency, since arrays could also cause mapping conflicts (e.g., `arg_0` mapped as `long` vs. as an array of longs).

Additionally, after fixing the code, the existing Elasticsearch index (`mewtwo-logs-2025.12.v2.0.1`) still has `arg_0` mapped as `long`. Either wait for the next month's index rollover (which will get a fresh mapping), or bump `CURRENT_LOG_VERSION` (line 5) to force a new index with correct mappings immediately.
