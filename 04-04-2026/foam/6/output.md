## TL;DR

The `ElasticsearchTransport._processNonObjectArg` method stores log arguments into dynamically-named fields (`arg_0`, `arg_1`, etc.) without type coercion, and there is no explicit Elasticsearch index template for `mewtwo-logs-*` indices. When Elasticsearch's dynamic mapping inferred `arg_0` as type `long` from an early numeric log argument, all subsequent log entries with string values in `arg_0` — including source code fragments routinely read by the AI agent platform — were rejected with a `document_parsing_exception`, causing silent log data loss.

## What Broke and Why

The `mewtwo` service uses a custom `ElasticsearchTransport` class to index application logs into monthly Elasticsearch indices named `mewtwo-logs-YYYY.MM.v2.0.1`. There is **no explicit index template or mapping configuration** anywhere in the codebase — the index relies entirely on Elasticsearch's dynamic mapping, which infers field types from the first document indexed.

When a log call like `log().info('message', someValue)` is processed, the `createLogObj` function in `/repo/mewtwo/src/logging.ts` separates the message string from the remaining arguments:

```typescript
const logObj: LogObj = {
    message: args.length > 0 && typeof args[0] === 'string' ? args[0] : undefined,
    ...
};
logObj.args = (typeof args[0] === 'string' ? args.slice(1) : args);
```

These args are then processed in `sendToElasticsearch` (`/repo/mewtwo/src/elasticsearch/transport.ts`). Object arguments are spread into the document via `_processObjectArg`, but **non-object arguments** (strings, numbers, booleans) are stored into positional fields by `_processNonObjectArg`:

```typescript
private _processNonObjectArg(baseFields: Record<string, unknown>, arg: unknown, i: number) {
    const key = `arg_${i}`;
    // ...
    baseFields[key] = arg instanceof Date ? arg.toISOString() : arg;
    // ← stores raw value: numbers stay numbers, strings stay strings
}
```

This creates the fatal type inconsistency. At some point early in the life of the `mewtwo-logs-2025.12.v2.0.1` index, a log call passed a numeric first argument (e.g., `log().info('msg', 42)`), causing Elasticsearch to dynamically map `arg_0` as type `long`. This mapping is **immutable** for the lifetime of that index.

Later, the AI agent platform — which routinely reads repository source files as part of its investigation workflows — logged a fragment of source code. Telemetry confirms the mechanism: `terminal-session.ts` reads file content and logs overlap previews:

```typescript
this.logger.debug(
    `Found line overlap with ${overlapSize} lines at position ${overlapIndex}`,
    { overlapPreview: overlapText.substring(0, 100), newContentLength: newContent.length }
);
```

The string `log().info('Creating worktree', { repoOwner, repoName, gitSha, worktreePath });` — literal source code from `git-worktree.service.ts:635` — flowed through the logging pipeline as a non-object argument, was stored as `arg_0`, and sent to Elasticsearch. Elasticsearch rejected it:

```
document_parsing_exception: [1:114] failed to parse field [arg_0] of type [long]
Preview of field's value: 'log().info('Creating worktree', { repoOwner, repoName, gitSha, worktreePath });'
```

The `processQueue` retry logic then retried this permanent 400 error 3 times (with no actual backoff despite config fields existing) before silently dropping the log event — no dead-letter queue, no alert, just data loss:

```typescript
if (queueItem.attempts >= this.retryConfig.maxRetries) {
    this.rawLog('[ElasticsearchTransport] Max retries reached, dropping item');
    this.queue.shift();
    return;
}
```

This is a **systemic issue**, not a one-off: the AI agent platform reads source files as core functionality, making arbitrary string content in log arguments inevitable. Any new monthly index where `arg_0` is first populated with a number will reproduce the same failure for all subsequent string-valued `arg_0` entries.

**Alternative hypothesis considered:** The source-code string was a bug in a specific log call. This was eliminated because telemetry shows multiple occurrences of the pattern across different timestamps, and the AI agent architecture inherently processes source file content as part of normal operation.

## Fix

**1. Coerce all `arg_N` values to strings in `_processNonObjectArg`** to ensure type consistency:

```typescript
private _processNonObjectArg(baseFields: Record<string, unknown>, arg: unknown, i: number) {
    const key = `arg_${i}`;
    if (typeof arg === 'object' && arg !== null) {
        try {
            if (Array.isArray(arg) && arg.length > 100) {
                baseFields[key] = `Array with ${arg.length} items`;
            } else {
                baseFields[key] = JSON.stringify(arg);  // coerce to string
            }
        } catch (_) {
            baseFields[key] = '[Complex object]';
        }
    } else {
        baseFields[key] = arg instanceof Date ? arg.toISOString() : String(arg);
        //                                                           ^^^^^^^^^^
        // Always coerce to string so arg_N fields have consistent type
    }
}
```

**2. Add an explicit Elasticsearch index template** for `mewtwo-logs-*` that maps `arg_*` fields as `keyword` (or `text`), preventing dynamic type inference:

```typescript
await client.indices.putIndexTemplate({
    name: 'mewtwo-logs',
    index_patterns: ['mewtwo-logs-*'],
    template: {
        mappings: {
            dynamic_templates: [
                {
                    arg_fields_as_keyword: {
                        match: 'arg_*',
                        mapping: { type: 'keyword', ignore_above: 1024 }
                    }
                }
            ]
        }
    }
});
```

**3. (Secondary) Distinguish retriable vs. non-retriable errors** in `processQueue` — skip retries for HTTP 400 responses since they are permanent failures, avoiding 3 futile retry attempts.

**Why this fix breaks the causal chain:** The `String(arg)` coercion ensures `arg_N` fields always contain string values, eliminating the type inconsistency at the source. The index template ensures that even if coercion is somehow bypassed, Elasticsearch will map `arg_*` fields as `keyword` rather than inferring `long` from a stray numeric value. Together, these prevent the `document_parsing_exception` from ever occurring — the step where Elasticsearch rejects a string value against a `long` mapping is no longer possible. The current broken index (`mewtwo-logs-2025.12.v2.0.1`) will self-heal when the next monthly index is created in January with the template in place.

---