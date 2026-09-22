[Foam Trace ID: e8dacc0cc91ebffc53821f1e23f8d212] ## TL;DR

Elasticsearch dynamic mapping locked `arg_0` as `long` from an earlier numeric log argument; a later call passing a raw string as the first positional argument is rejected. The fix is to serialise log arguments as explicit JSON so `arg_*` fields disappear.

## What Broke and Why

**Observed error:** `document_parsing_exception: failed to parse field [arg_0] of type [long]`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** The `mewtwo` Elasticsearch transport spreads positional log args into `arg_0..n`.

**2.** Dynamic mapping infers the type from the first document; later documents with a different type for the same field are rejected.

**3.** The offending call logs a source-code string as `arg_0`.

## Fix

- Serialise `args` to a single JSON string field (or use `keyword` with `ignore_malformed`) and reindex.


---
