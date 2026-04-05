## TL;DR
Elasticsearch `document_parsing_exception` caused by the logging transport storing non-object log arguments in generic `arg_N` fields with inconsistent types, triggering dynamic mapping conflicts when `arg_0` was first mapped as `long` (from a numeric arg) then received a string value.

## What Broke and Why

**The Error**: A `ResponseError` from Elasticsearch with `document_parsing_exception`: the field `arg_0` in index `mewtwo-logs-2025.12.v2.0.1` was dynamically mapped as `long` (from an earlier document with a numeric value), but a subsequent log document attempted to store a string value (`log().info('Creating worktree', { repoOwner, repoName, gitSha, worktreePath });`) in the same field. Elasticsearch rejected this with HTTP 400, and the error cascaded — 39 failed index operations were recorded in a single hour.

**Root Cause**: The `ElasticsearchTransport._processNonObjectArg()` method (in `mewtwo/src/elasticsearch/transport.ts`) stored raw, untyped values in `arg_0`, `arg_1`, etc. fields:

```typescript
// Line 313 — stores the raw value with its original type
baseFields[key] = arg instanceof Date ? arg.toISOString() : arg;
```

When different log calls passed different types as positional arguments (numbers from `log().trace('validateData', data)` in `base.ts`, strings from `log().error('message', error)` in various files), Elasticsearch's dynamic mapping would lock the field to the first type encountered. All subsequent documents with a different type for the same field were rejected.

**Contributing Factor**: Before commit `79390570` ("Fix logs (#97)"), dozens of log calls across 43 files used the pattern `log().method('message', error)` where `error` was passed as a raw positional argument. If `error` was a non-object (string, number), it would be stored as `arg_0` with its raw type, creating type inconsistencies across documents in the same ES index.

**Cascading Impact**: Once the mapping conflict occurred, the transport's retry mechanism re-queued the failed document (up to `maxRetries` times), and every other log document with a conflicting `arg_0` type also failed. This created a flood of 400 errors, effectively silencing the application's Elasticsearch logging for any log entry that happened to produce a non-object argument.

## Fix

### Fix 1: Already applied in commit `79390570` (log call pattern)
All log calls were changed from `log().method('message', error)` to `log().method('message', { error })`, ensuring arguments always go through `_processObjectArg` (which spreads named keys at root level) rather than `_processNonObjectArg` (which creates generic `arg_N` fields).

### Fix 2: Harden the transport (applied in this investigation)
Modified `_processNonObjectArg` in `mewtwo/src/elasticsearch/transport.ts` to **always coerce values to strings**, preventing type conflicts even if new code accidentally uses the old pattern:

```typescript
// Before: stored raw values (number, string, boolean, etc.)
baseFields[key] = arg instanceof Date ? arg.toISOString() : arg;

// After: always coerce to string for consistent ES mapping
baseFields[key] = String(arg);
// And for object/array args:
baseFields[key] = safeStringify(arg);  // instead of storing raw object
```

This ensures `arg_N` fields always have type `text` in Elasticsearch, eliminating the class of dynamic mapping conflicts entirely. The named fields from `_processObjectArg` (e.g., `error`, `userId`, `repoOwner`) remain typed correctly since each field name is semantically consistent across log calls.

---
