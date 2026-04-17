[Foam Trace ID: 5e3cfad06db54e295df7d5df8b528154] ## TL;DR

Commit `13e460e` ("Update drain3 polling #332") rewrote `getProjectRoot()` in `drain3-pyodide.service.ts` to derive the project root from `import.meta.url`. In the production Docker container, the compiled file lives at `/app/mewtwo/dist/src/services/drain3-pyodide.service.js` — going up only 2 directory levels resolves to `/app/mewtwo/dist` instead of `/app/mewtwo/`, so `pyodide.mountNodeFS` is given a non-existent path, `foam_wrapper.py` is never added to Python's `sys.path`, and every Pyodide call fails with `ModuleNotFoundError: No module named 'foam_wrapper'`. The fix is to go up 3 levels (or restore the original `findUpSync`-based approach) so the path resolves correctly in production.

---

## What Broke and Why

### The Regression — `getProjectRoot()` in commit `13e460e`

The `mewtwo` service runs a BullMQ worker (`exception-polling.worker.ts`) that polls for new exception spans and clusters them via a drain3 algorithm running inside **Pyodide** (Python 3.13 in WebAssembly). The core Python module `foam_wrapper` is a plain `.py` file bundled at `mewtwo/vendor/drain3/foam_wrapper.py` in the Docker image. At Pyodide initialization time, `drain3-pyodide.service.ts` mounts that vendor directory into the Pyodide WASM filesystem using `pyodide.mountNodeFS` and adds it to `sys.path` — making `foam_wrapper` importable by all downstream Python scripts.

The vendor directory path is computed by `getProjectRoot()`. Commit `13e460e` changed this function from a `findUpSync`-based approach (which correctly walked up from `process.cwd()` until it found `package.json`) to one that derives the root from `import.meta.url`:

**Before (correct):**
```typescript
function getProjectRoot(): string {
    const packageJsonPath = findUpSync('package.json', { cwd: process.cwd() });
    if (packageJsonPath) {
        return path.dirname(packageJsonPath);
    }
    return process.cwd();
}
// → /app/mewtwo/  ✅
// drain3VendorPath = /app/mewtwo/vendor/drain3  ✅
```

**After (broken):**
```typescript
function getProjectRoot(): string {
    // This file is at: mewtwo/src/services/drain3-pyodide.service.ts
    const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
    // Navigate up: services -> src -> mewtwo (or dist/src/services -> dist/src -> dist -> mewtwo)
    return path.resolve(currentFileDir, '..', '..');
}
// Comment claims it handles both cases — but it does NOT
```

In the Docker production container, TypeScript is compiled and the output lives at:
```
/app/mewtwo/dist/src/services/drain3-pyodide.service.js
```

The path arithmetic plays out as:
- `import.meta.url` → `/app/mewtwo/dist/src/services/drain3-pyodide.service.js`
- `path.dirname(...)` → `/app/mewtwo/dist/src/services`
- `path.resolve(..., '..', '..')` → `/app/mewtwo/dist`  ❌

So `drain3VendorPath` = `/app/mewtwo/dist/vendor/drain3` — **a path that does not exist** in the container. The actual vendor files are at `/app/mewtwo/vendor/drain3/` (one level higher), correctly copied into the image by `COPY mewtwo/ ./mewtwo/` in `Dockerfile.production`.

### Silent Failure in `mountNodeFS`

`pyodide.mountNodeFS('drain3_vendor', '/app/mewtwo/dist/vendor/drain3')` is called with the non-existent path. Rather than throwing, Pyodide's Node.js FS integration silently mounts an empty virtual directory. The subsequent `sys.path.insert` adds `/home/pyodide/drain3_vendor` to Python's path, but since that directory is empty, `foam_wrapper` is never findable.

### Rejected Initialization Promise Propagates to All Services

The Pyodide initialization routine verifies the import immediately after mounting:
```python
from foam_wrapper import get_wrapper
```
This fails with `ModuleNotFoundError: No module named 'foam_wrapper'`, causing `initializePyodide()` to reject. The singleton stores this as a **permanently rejected** `initializationPromise`:

```typescript
if (initializationPromise) {
    return initializationPromise;  // returns the already-rejected promise every time
}
```

Every subsequent call to any exported function (`processFoamLogBatch`, `loadFoamIssueState`, etc.) awaits this rejected promise and throws immediately. Additionally, each inline Python script passed to `runPythonAsync` begins with `from foam_wrapper import process_log_batch`, which also fails with the same `ModuleNotFoundError`.

This is why the failure was **systemic across all services** in the polling cycle — every `(customerId, serviceId)` pair (`webapp-browser`, `porygon-browser`, `mewtwo`, `mono`) failed with the identical error:
```
PythonError: ModuleNotFoundError: No module named 'foam_wrapper'
```

All confirmed in telemetry at trace `fdec5013f9fa0ab08c32c5105ee7c656`, timestamp `2026-03-02 02:33:39.607`, immediately following the deployment of commit `13e460e` on ~Sun Mar 1 2026 18:08 PST.

---

## Fix

**Fix `getProjectRoot()` in `mewtwo/src/services/drain3-pyodide.service.ts` to go up 3 directory levels instead of 2**, so the path resolves correctly from the compiled output location in production:

```typescript
function getProjectRoot(): string {
    // Compiled file is at: dist/src/services/drain3-pyodide.service.js
    // Navigate up: services -> src -> dist -> mewtwo (project root)
    const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(currentFileDir, '..', '..', '..');
}
// → /app/mewtwo/  ✅
// drain3VendorPath = /app/mewtwo/vendor/drain3  ✅
```

Alternatively, **restore the original `findUpSync` approach** which is more robust and environment-agnostic (it doesn't depend on source vs. compiled directory depth):

```typescript
function getProjectRoot(): string {
    const packageJsonPath = findUpSync('package.json', { cwd: process.cwd() });
    if (packageJsonPath) {
        return path.dirname(packageJsonPath);
    }
    return process.cwd();
}
```

**Why this fix breaks the causal chain:** With the corrected path, `drain3VendorPath` = `/app/mewtwo/vendor/drain3` (which exists in the container). `mountNodeFS` mounts the real vendor directory containing `foam_wrapper.py` into Pyodide's virtual filesystem. `sys.path.insert` makes it importable. The initialization verification `from foam_wrapper import get_wrapper` succeeds. `initializationPromise` settles as a resolved promise, and all downstream `processBatch` calls proceed normally — the `ModuleNotFoundError` can no longer occur.


---
