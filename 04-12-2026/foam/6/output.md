[Foam Trace ID: c3fe2122ff9c5e29e8d69fa916960e03] ## TL;DR

The `mewtwo` service's Elasticsearch log index (`mewtwo-logs-2025.12.v2.0.1`) has no explicit mapping template, so Elasticsearch dynamically mapped the field `arg_0` as `long` the first time a numeric value was written to it. A code-gen pipeline in `parse.ts` later logged a raw JavaScript source-code string as the second positional argument to `log().debug()`, which was stored in `arg_0`; Elasticsearch rejected the document with a `document_parsing_exception` because a string is not a valid `long`. The fix is to define an explicit Elasticsearch index template that maps `arg_N` fields as `keyword` (or uses `ignore_malformed`) so that mixed-type log arguments no longer conflict.

---

## What Broke and Why

### 1. The Call Site That Produced the Bad Document

In `parse.ts`, the search-and-replace diff strategy processes LLM-generated diffs applied to source files. When a single-line SEARCH block is found, the code takes the fuzzy match branch and logs the search term:

```typescript
// /repo/mewtwo/src/code-gen/diff-strategies/search-and-replace/parse.ts:248
log().debug('Attempting single-line fuzzy match:', searchLines[0]);
```

At runtime, `searchLines[0]` was the literal source code text from the LLM's SEARCH block targeting `git-worktree.service.ts`:

```
log().info('Creating worktree', { repoOwner, repoName, gitSha, worktreePath });
```

### 2. How That String Became `arg_0` in Elasticsearch

The `mewtwo` logging system (`/repo/mewtwo/src/logging.ts`, `createLogObj`) processes `log()` call arguments as follows:

```typescript
const logObj: LogObj = {
    message: args.length > 0 && typeof args[0] === 'string' ? args[0] : undefined,
    // ...
};
if (args.length > 1 || ...) {
    logObj.args = (typeof args[0] === 'string' ? args.slice(1) : args);
}
```

For `log().debug('Attempting single-line fuzzy match:', searchLines[0])`:
- `args[0]` = `'Attempting single-line fuzzy match:'` → string → becomes `logObj.message`
- `args[1]` = `searchLines[0]` (the source-code string) → becomes `logObj.args[0]`

In `ElasticsearchTransport.sendToElasticsearch()`, the args are iterated and non-object values are stored by positional index:

```typescript
// /repo/mewtwo/src/elasticsearch/transport.ts
private _processNonObjectArg(baseFields: Record<string, unknown>, arg: unknown, i: number) {
    const key = `arg_${i}`;
    baseFields[key] = arg instanceof Date ? arg.toISOString() : arg;
}
```

Since `logObj.args[0]` is a string (not a plain object), `_processNonObjectArg` stored it as `arg_0 = "log().info('Creating worktree', { repoOwner, repoName, gitSha, worktreePath });"`.

### 3. Why Elasticsearch Rejected It — The Dynamic Mapping Lock-In

The `mewtwo-logs-2025.12.v2.0.1` index has **no explicit mapping template** anywhere in the codebase (confirmed: zero results for `putIndexTemplate`, `createIndex`, `mappings` in the repo). Elasticsearch is operating with default `dynamic: true` mapping.

Prior log calls in `/repo/mewtwo/src/clients/github/index.ts` (`applyDiff()`) regularly pass numeric diff statistics as positional arguments:

```typescript
// github/index.ts:957 — chunk.oldStart and chunk.oldLines are integers
log().info(`Processing chunk: ${chunk.content}`, chunk.oldStart, chunk.oldLines);

// github/index.ts:973 — lines.length is an integer
log().trace('post splice', lines.length);
```

These calls caused Elasticsearch to dynamically map `arg_0 → long` the first time they were indexed in the `2025.12.v2.0.1` index. Once committed, **all subsequent documents in the same index must supply a parseable `long` for `arg_0`**. There is no `ignore_malformed`, `coerce`, or `dynamic_templates` configuration to soften this.

### 4. Complete Causal Chain

```
LLM generates diff with SEARCH block = "log().info('Creating worktree', ...);"
  └─ parse.ts: parseDiffBlocks() → searchReplacePairs
       └─ parse.ts: performSearchAndReplace()
            └─ searchLines = search.split('\n') → ["log().info('Creating worktree', ...);"]
                 └─ searchLines.length === 1 → single-line fuzzy match branch
                      └─ parse.ts:248: log().debug('Attempting single-line fuzzy match:', searchLines[0])
                           └─ createLogObj: logObj.args = ["log().info('Creating worktree', ...);"]
                                └─ _processNonObjectArg: baseFields['arg_0'] = <source code string>
                                     └─ Elasticsearch: arg_0 is mapped as `long`, string rejected
                                          └─ HTTP 400: document_parsing_exception
```

---

## Fix

### Root Cause Fix: Define an Explicit Elasticsearch Index Template

The root cause is that the `mewtwo-logs-*` index has no explicit mapping, so Elasticsearch's dynamic mapper locks field types based on the first document received. Any future log call that passes a non-numeric value as its first positional argument (a very reasonable thing to do) will collide with the `long` mapping established by diff-stat log calls.

Define an explicit index template that maps `arg_N` fields as `keyword` (or uses `ignore_malformed: true`):

```typescript
// /repo/mewtwo/src/elasticsearch/transport.ts — add during client initialization
await this.elasticClient.indices.putIndexTemplate({
    name: 'mewtwo-logs-template',
    index_patterns: ['mewtwo-logs-*'],
    template: {
        mappings: {
            dynamic: true,
            dynamic_templates: [
                {
                    arg_fields: {
                        path_match: 'arg_*',
                        mapping: { type: 'keyword', ignore_above: 32766 }
                    }
                }
            ]
        }
    }
});
```

**Why this breaks the causal chain:** With this template in place, when `arg_0` is first seen with a numeric value (e.g., `chunk.oldStart`), Elasticsearch will map it as `keyword` instead of `long`, which accepts any string value. The `document_parsing_exception` cannot recur because no type mismatch is possible — all `arg_N` fields accept both numeric strings and arbitrary strings.

### Secondary Fix: Avoid Logging Raw Source-Code Strings as Positional Arguments

The immediate call site in `parse.ts:248` should log the source string as part of a structured object rather than as a bare positional argument, preventing it from ever reaching `arg_0`:

```typescript
// Before (problematic):
log().debug('Attempting single-line fuzzy match:', searchLines[0]);

// After (structured — the string is spread as an object key, not stored as arg_0):
log().debug('Attempting single-line fuzzy match', { searchLine: searchLines[0] });
```

This is a useful defensive change but is **not sufficient on its own**: without the index template fix, any other call site passing a non-numeric string as the first positional arg would still hit the same mapping conflict.

---
