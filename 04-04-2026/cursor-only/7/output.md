## TL;DR
Commit `13e460e` refactored `getProjectRoot()` in `drain3-pyodide.service.ts` to use `import.meta.url` instead of `findUpSync`, but only navigates 2 directory levels up from the compiled file — landing in `mewtwo/dist/` instead of `mewtwo/`. This causes Pyodide to mount a nonexistent `vendor/drain3` path, so all Python-based drain3 clustering fails in production.

## What Broke and Why
The commit made two changes that combined to cause the failure:

**Change 1 — Exception polling enabled in production:** In `index.ts`, the guard `if (isDevelopmentEnvironment || !LOCAL_OVERRIDE)` was simplified to `if (isDevelopmentEnvironment)`. Since `LOCAL_OVERRIDE` was not set in production, the old code disabled polling there. The new code enables polling in all non-development environments, meaning exception polling ran in production for the first time after this deploy.

**Change 2 — Broken vendor path resolution:** `getProjectRoot()` in `drain3-pyodide.service.ts` was changed from using `findUpSync('package.json')` (which correctly returned the `mewtwo/` workspace root) to a `import.meta.url`-based approach that navigates 2 levels up from the current file's directory:

```typescript
const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
return path.resolve(currentFileDir, '..', '..');
```

This works in development where the source file is at `mewtwo/src/services/drain3-pyodide.service.ts` (2 levels up → `mewtwo/`). But in production, `tsc` compiles to `mewtwo/dist/src/services/drain3-pyodide.service.js` — the `dist/` directory adds an extra level. Two levels up from `dist/src/services/` lands at `mewtwo/dist/`, not `mewtwo/`.

The resulting vendor path `mewtwo/dist/vendor/drain3` does not exist. The actual vendor directory is at `mewtwo/vendor/drain3`.

**Failure chain:**
1. Pyodide initializes and calls `mountNodeFS('drain3_vendor', '/app/mewtwo/dist/vendor/drain3')` — mounting a nonexistent host directory.
2. The Python verification step (`from drain3 import TemplateMiner`) fails because the mounted path has no files.
3. Critically, `pyodideInstance` was already assigned before the mount/verification step, so when the initialization promise rejects, subsequent calls to `initializePyodide()` see `pyodideInstance` as non-null and return immediately — skipping the failed initialization.
4. Every subsequent `processFoamLogBatch` call executes `from foam_wrapper import process_log_batch` against a broken mount, producing the Python traceback: `Traceback (most recent call last): File "/lib/python313.zip/_pyodide/_base.py", line 597, in eval_code_async...`
5. `processBatch` catches this error and returns `{ success: false }`.
6. The worker at line 327 re-throws: `throw new Error("Failed to process batch for 674e5380f251f603c5ef1847:webapp-browser: Traceback...")`.

## Fix
In `mewtwo/src/services/drain3-pyodide.service.ts`, update `getProjectRoot()` to account for the extra `dist/` level in production builds:

```typescript
function getProjectRoot(): string {
  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  // In source: src/services → 2 levels up → mewtwo/
  // In dist:   dist/src/services → 2 levels up → dist/ → need 1 more → mewtwo/
  const twoUp = path.resolve(currentFileDir, '..', '..');
  if (path.basename(twoUp) === 'dist') {
    return path.resolve(twoUp, '..');
  }
  return twoUp;
}
```

Additionally, fix the initialization guard in `initializePyodide()` so that a failed initialization doesn't leave `pyodideInstance` in a partially-initialized state — move `pyodideInstance = await loadPyodide(...)` to after the verification step, or reset it on failure:

```typescript
initializationPromise = (async () => {
  // ...
  const instance = await loadPyodide(...);
  // ... mount, install, verify ...
  await instance.runPythonAsync(`from drain3 import TemplateMiner ...`);
  // Only assign after full success
  pyodideInstance = instance;
})().catch((err) => {
  pyodideInstance = null;
  initializationPromise = null;
  throw err;
});
```

This ensures that if initialization fails, the next call will retry rather than silently proceeding with a broken instance.
