## TL;DR

Elasticsearch dynamic mapping locked `arg_0` as `long` from an earlier numeric log argument; a later call passing a raw string as the first positional argument is rejected. The fix is to serialise log arguments as explicit JSON so `arg_*` fields disappear.

## What Broke and Why

**Observed error:** `document_parsing_exception: failed to parse field [arg_0] of type [long]`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** The `mewtwo` Elasticsearch transport spreads positional log args into `arg_0..n`.

**2.** Dynamic mapping infers the type from the first document; later documents with a different type for the same field are rejected.

**3.** The offending call logs a source-code string as `arg_0`.

## Fix

- Serialise `args` to a single JSON string field (or use `keyword` with `ignore_malformed`) and reindex.

---

## Metrics

**Performance:**
- Total latency: 701 seconds
- Token usage: 553,179 + 7,076 = 560,255 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, shell, list_dir
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
