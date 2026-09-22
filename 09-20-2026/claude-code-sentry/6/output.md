## TL;DR

Elasticsearch dynamic mapping locked `arg_0` as `long` from an earlier numeric log argument; a later call passing a raw string as the first positional argument is rejected. The fix is to serialise log arguments as explicit JSON so `arg_*` fields disappear.

## What Broke and Why

**Observed error:** `document_parsing_exception: failed to parse field [arg_0] of type [long]`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The `mewtwo` Elasticsearch transport spreads positional log args into `arg_0..n`.

**2.** Dynamic mapping infers the type from the first document; later documents with a different type for the same field are rejected.

**3.** The offending call logs a source-code string as `arg_0`.

## Fix

- Serialise `args` to a single JSON string field (or use `keyword` with `ignore_malformed`) and reindex.

---

## Metrics

**Performance:**
- Total latency: 283 seconds
- Token usage: 189,822 + 7,001 = 196,823 tokens

**Tool Usage:**
- Top 3 most-used tools: Glob, Grep, Read
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) search_issue_events (input: events around the error timestamp) Read (input: the throwing function and its callers)
