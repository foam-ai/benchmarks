## TL;DR

Commit `13e460e` ("Update drain3 polling #332") introduced two changes simultaneously: it re-enabled exception polling in production AND replaced a reliable `findUpSync('package.json')` project-root resolution with a brittle `import.meta.url + ../../` traversal. In production, the TypeScript compilation adds a `dist/` directory level that the new `../../` path doesn't account for, causing the `vendor/drain3` filesystem mount to point at a non-existent directory — making `foam_wrapper` unimportable in Pyodide. Every subsequent `from foam_wrapper import ...` call fails with `ModuleNotFoundError: No module named 'foam_wrapper'`, crashing the batch processor for all customers.

## What Broke and Why

### The Two-Part Change

Commit `13e460e338f57c9900a1328ccc134d75b16c188f` ("Update drain3 polling #332", by Brian Sturdivan, 2026-03-01) made two changes to `mewtwo`:

**Change 1 — `index.ts`: Exception polling re-enabled in production**
```typescript
// Before:
if (isDevelopmentEnvironment || !LOCAL_OVERRIDE) {
    log().info('Exception polling is disabled');
    return;
}

// After:
if (isDevelopmentEnvironment) {
    log().info('Exception polling is disabled (non-production environment)');
    return;
}
```
This change intentionally re-enabled the exception polling worker in production for the first time, causing the drain3/Pyodide code path to actually run in production.

**Change 2 — `drain3-pyodide.service.ts`: `getProjectRoot()` rewritten with a path traversal bug**
```typescript
// Before (correct — works in both dev and prod):
import { findUpSync } from 'find-up';
function getProjectRoot(): string {
    const packageJsonPath = findUpSync('package.json', { cwd: process.cwd() });
    if (packageJsonPath) {
        return path.dirname(packageJsonPath);
    }
    return process.cwd();
}

// After (broken in production):
import { fileURLToPath } from 'url';
function getProjectRoot(): string {
    // "This file is at: mewtwo/src/services/drain3-pyodide.service.ts"
    const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
    // Navigate up: services -> src -> mewtwo
    return path.resolve(currentFileDir, '..', '..');
}
```

The comment in the new code describes the **development** directory layout correctly, but in **production** the TypeScript compiler outputs to `dist/`, so the file lives at `dist/src/services/drain3-pyodide.service.js`. Navigating `../../` from `dist/src/services/` only reaches `dist/` — one level short of the actual project root:

| Environment | `currentFileDir` | After `../..` | Needed |
|---|---|---|---|
| **Development** (`tsx`) | `/app/src/services` | `/app` ✅ | `/app` |
| **Production** (`node dist/`) | `/app/dist/src/services` | `/app/dist` ❌ | `/app` |

### The Downstream Failure Chain

`getProjectRoot()` is used to locate the `vendor/drain3` directory, which contains the `foam_wrapper` Python package and the `drain3` library that Pyodide must mount:

```typescript
const projectRoot = getProjectRoot();                              // /app/dist  ← WRONG in prod
const drain3VendorPath = path.join(projectRoot, 'vendor', 'drain3'); // /app/dist/vendor/drain3 ← doesn't exist
pyodideInstance.mountNodeFS('drain3_vendor', drain3VendorPath);
// sys.path.insert(0, '/home/pyodide/drain3_vendor')
// from drain3 import TemplateMiner     ← path exists but points to empty/wrong dir
// from foam_wrapper import load_state  ← FAILS
```

When `from foam_wrapper import load_state` runs inside any `runPythonAsync()` call, Pyodide raises:

```
ModuleNotFoundError: No module named 'foam_wrapper'
```

This error propagates through Pyodide's `eval_code_async → run_async` call stack, surfaces as a `PythonError` in Node.js, is caught in `foam-issue-batch-processor.service.ts` and wrapped:

```
Error: Failed to process batch for 674e5380f251f603c5ef1847:webapp-browser:
  PythonError: Traceback (most recent call last):
    File "/lib/python313.zip/_pyodide/_base.py", line 597, in eval_code_async
    ...
  ModuleNotFoundError: No module named 'foam_wrapper'
```

This is then re-thrown at `exception-polling.worker.ts:327`, caught by BullMQ's `MonitoredWorker.retryIfFailed` at `worker.ts:1251`, and scheduled for retry — which will keep failing until the code is fixed.

### Telemetry Confirmation

The span chain (traceId=`fdec5013f9fa0ab08c32c5105ee7c656`) shows:
- `02:33:39.476` — "Started batch processing with 1 log (determinant: disabled)"
- `02:33:39.476` — "Syncing state from MongoDB (last sync: never)"
- `02:33:39.517` — "Initial load: fetching all clusters (found 0 masks)"
- `02:33:39.584` — "Loading state for drain3-pyodide with **16 clusters** and 0 masks"
- `02:33:39.606` — **PythonError: `ModuleNotFoundError: No module named 'foam_wrapper'`** (0ms duration error span)
- `02:33:39.606` — **Error: Failed to process batch for 674e5380f251f603c5ef1847:webapp-browser** (0ms duration error span)
- `02:33:39.607` — "delay exception-polling" (BullMQ retry scheduled)

The 16 clusters were fetched from MongoDB successfully, but the first actual Python call (`from foam_wrapper import load_state`) immediately hit `ModuleNotFoundError`.

### Why the Two Changes Together Cause the Failure

Before this commit, exception polling was disabled in production — so the broken `getProjectRoot()` was never exercised. The re-enabling of production polling and the path-resolution regression were introduced in the same commit, making the bug immediately observable upon deployment.

## Fix

**Fix `getProjectRoot()` to correctly resolve the project root in both development and production environments.**

**Option 1 (Simplest — restore `find-up`):**
```typescript
import { findUpSync } from 'find-up';

function getProjectRoot(): string {
    const packageJsonPath = findUpSync('package.json', { cwd: import.meta.dirname ?? process.cwd() });
    if (packageJsonPath) {
        return path.dirname(packageJsonPath);
    }
    return process.cwd();
}
```
This was the pre-existing, proven approach. `findUpSync` walks up the directory tree from the current file's directory, finds `package.json`, and returns its containing directory — regardless of whether the file is in `src/services/` (dev) or `dist/src/services/` (prod).

**Option 2 (Fix the traversal depth for production):**
```typescript
function getProjectRoot(): string {
    const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
    // In production: dist/src/services → dist/src → dist → app (project root)
    // In development: src/services → src → app (project root)
    // Use find-up or detect via IS_PROD env var, OR use 3 levels for prod:
    return path.resolve(currentFileDir, '..', '..', '..');
}
```
However, this is fragile — it would break in development where only two `..` levels are needed. Option 1 is strongly preferred.

**Option 3 (Environment variable):**
Set a `VENDOR_DIR` environment variable in the production deployment pointing to the absolute path of `vendor/drain3`, and read it in the service. This decouples path resolution from runtime file location entirely.

**Why this fix breaks the causal chain:** By restoring a correct `getProjectRoot()`, `drain3VendorPath` resolves to the actual `/app/vendor/drain3` directory in both environments. The `mountNodeFS` call succeeds, `sys.path` contains the correct vendor directory, `import foam_wrapper` resolves, and `ModuleNotFoundError` can no longer occur. The exception polling worker processes batches successfully.

---