[Foam Trace ID: 79a46e258331bfbc34438d9d8841947e] ## TL;DR

The `mewtwo` service's Elasticsearch logging transport serializes log arguments into positional fields (`arg_0`, `arg_1`, etc.) that can hold any type, but no explicit index mapping exists for `mewtwo-logs-*` indices. Elasticsearch's dynamic mapping locked `arg_0` to type `long` from the first document with a numeric value, causing all subsequent documents with non-numeric `arg_0` values to fail with `document_parsing_exception`. The fix is to add an explicit index template that maps `arg_*` fields as `keyword` (or coerce all values to strings in the transport).

## What Broke and Why

The `mewtwo` service uses a custom `ElasticsearchTransport` class (`/elasticsearch/transport.ts`) that buffers log entries and periodically flushes them to Elasticsearch via a timer-based queue:

```
at async Timeout._onTimeout (/elasticsearch/transport.ts:57:17)
at async ElasticsearchTransport.processQueue (/elasticsearch/transport.ts:108:17)
at async Client.IndexApi (@elastic/src/api/api/index.ts:83:10)
```

The transport serializes structured log call arguments into positional fields. When `log().info(message, ...args)` is called, each argument is processed through one of two methods:

```typescript
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
        this._processObjectArg(baseFields, arg, i);  // Spreads object keys into baseFields
    } else {
        this._processNonObjectArg(baseFields, arg, i);  // Sets baseFields[`arg_${i}`] = arg
    }
}
```

Object arguments get spread into the document as individual named fields, while **primitive arguments (strings, numbers) are stored as `arg_0`, `arg_1`, etc.**. This means `arg_0` is inherently **polymorphic** — it can be a number from one log call and a string from another.

The index name is dynamically constructed with no corresponding index template:

```typescript
index: `mewtwo-logs-${timestamp.getFullYear()}.${String(timestamp.getMonth() + 1).padStart(2, '0')}.${CURRENT_LOG_VERSION}`
```

Confirmed: **no explicit index template, component template, or mapping configuration exists anywhere in the codebase** (zero matches for `index_patterns`, `mappings`, `putTemplate`, `putIndexTemplate` across the entire repo). This means Elasticsearch uses **dynamic mapping** — inferring field types from the first document indexed.

When the index `mewtwo-logs-2025.12.v2.0.1` was created, the first document containing an `arg_0` field happened to have a numeric value. Elasticsearch locked `arg_0` to type `long`. All subsequent documents must conform:

> `failed to parse field [arg_0] of type [long] in document with id 'SRB7WJsBZqWjny1Va7b8'. Preview of field's value: 'log().info('Creating worktree', { repoOwner, repoName, gitSha, worktreePath });'`

The failing document's `arg_0` contained literal source code text — the text of line 635 from `git-worktree.service.ts`. This string (containing `log().info('Creating worktree', ...)` with a trailing semicolon and unresolved identifier names) was passed as a primitive log argument through some source-line enrichment or code-scanning path, processed by `_processNonObjectArg` into `arg_0`, and sent to Elasticsearch without any type validation, where it was rejected as unparseable as `long`.

**The causal chain:**
1. No explicit Elasticsearch index template exists → dynamic mapping is used
2. First document with a numeric `arg_0` locks the field type to `long` for the index lifetime
3. A subsequent log entry has a string value for `arg_0` (source code text from a source-line capture mechanism)
4. `ElasticsearchTransport` performs no type validation/coercion before indexing
5. Elasticsearch rejects the document with HTTP 400 `document_parsing_exception`

**Alternative hypothesis considered:** The source-line capture mechanism inserting literal source code into log arguments could be the primary bug. However, even without source-line capture, *any* log call that passes a string as the first positional argument would fail identically. The fundamental issue is the absence of an explicit mapping for inherently polymorphic `arg_*` fields combined with Elasticsearch's type-locking dynamic mapping behavior.

## Fix

**Add an explicit Elasticsearch index template for `mewtwo-logs-*`** that maps all `arg_*` fields to a string type using a dynamic template:

```json
{
  "index_patterns": ["mewtwo-logs-*"],
  "template": {
    "mappings": {
      "dynamic_templates": [
        {
          "args_as_keyword": {
            "match_pattern": "regex",
            "match": "^arg_\\d+$",
            "mapping": {
              "type": "keyword"
            }
          }
        }
      ]
    }
  }
}
```

Additionally, **coerce all `arg_*` values to strings in `_processNonObjectArg`** as a defense-in-depth measure:

```typescript
_processNonObjectArg(baseFields: Record<string, any>, arg: any, i: number) {
    baseFields[`arg_${i}`] = String(arg);
}
```

**Why this fixes the root cause:** The explicit dynamic template ensures that `arg_*` fields are always mapped as `keyword` regardless of which document is indexed first, eliminating the non-deterministic type-locking behavior. The transport-side coercion provides an additional safety layer ensuring type consistency before the data reaches Elasticsearch. Together, these changes break the causal chain at step 1-2 (no more type-locking to `long`) and step 4 (values are always strings).

---
