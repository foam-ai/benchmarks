## TL;DR
`getProjectRoot()` refactor in drain3-pyodide.service.ts navigates up only 2 directories from `import.meta.url`, but production builds (`tsc` → `dist/src/services/`) require 3, causing vendor path resolution to point at `mewtwo/dist/vendor/drain3` (nonexistent) instead of `mewtwo/vendor/drain3`.

## What Broke and Why

Commit `13e460e3` ("Update drain3 polling #332") made two changes:

**1. Enabled exception polling in production** by simplifying the guard in `mewtwo/src/index.ts`:
```typescript
// BEFORE: polling disabled unless LOCAL_OVERRIDE env var was set
if (isDevelopmentEnvironment || !LOCAL_OVERRIDE) { ... return; }

// AFTER: polling only disabled in development
if (isDevelopmentEnvironment) { ... return; }
```

**2. Replaced `getProjectRoot()` in `drain3-pyodide.service.ts`** from a robust `findUpSync('package.json')` approach to a fragile `import.meta.url` approach:
```typescript
// BEFORE (worked in all contexts):
const packageJsonPath = findUpSync('package.json', { cwd: process.cwd() });
return path.dirname(packageJsonPath);

// AFTER (broken in production):
const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
return path.resolve(currentFileDir, '..', '..');
```

The comment in the new code even documents the bug:
> `// Navigate up: services -> src -> mewtwo (or dist/src/services -> dist/src -> dist -> mewtwo)`

In development, the source file is at `mewtwo/src/services/drain3-pyodide.service.ts` — going up 2 directories (`..`, `..`) correctly reaches `mewtwo/`.

In production, `tsc` compiles to `mewtwo/dist/src/services/drain3-pyodide.service.js` — going up 2 directories reaches `mewtwo/dist/`, NOT `mewtwo/`. The comment lists 3 hops (dist/src/services → dist/src → dist → mewtwo) but the code only does 2.

This means `drain3VendorPath` resolves to `mewtwo/dist/vendor/drain3` which doesn't exist. When Pyodide tries to mount this path and import drain3/foam_wrapper, the Python code fails with the traceback seen in the error:
```
Traceback (most recent call last):
  File "/lib/python313.zip/_pyodide/_base.py", line 597, in eval_code_async
    await CodeRunner(... .run_async(globals, loca...
```

The error surfaces at line 328 of `exception-polling.worker.ts`:
```typescript
throw new Error(
  `Failed to process batch for ${customerId}:${serviceId}: ${result.error?.message}`,
);
```

The affected customer `674e5380f251f603c5ef1847` with service `webapp-browser` was one of the first to be processed after this deploy, since the polling guard removal (change #1) made polling active for all production customers.

**Timeline context**: This was the third attempt to fix exception polling being disabled in prod — commit `5d6f824b` (#330) tried first, was reverted in `19f26db9` (#331), and this commit (#332) tried again but introduced the `getProjectRoot` regression.

## Fix

**Immediate fix** — Revert `getProjectRoot()` to the proven `findUpSync` approach:

```typescript
import { findUpSync } from 'find-up';  // restore this import
// remove: import { fileURLToPath } from 'url';

function getProjectRoot(): string {
    const packageJsonPath = findUpSync('package.json', { cwd: process.cwd() });
    if (packageJsonPath) {
        return path.dirname(packageJsonPath);
    }
    return process.cwd();
}
```

**Alternative fix** if `findUpSync` is undesirable — account for the `dist/` nesting:

```typescript
function getProjectRoot(): string {
    const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
    // In dev: src/services -> 2 levels up to mewtwo root
    // In prod: dist/src/services -> 3 levels up to mewtwo root
    if (currentFileDir.includes(path.sep + 'dist' + path.sep)) {
        return path.resolve(currentFileDir, '..', '..', '..');
    }
    return path.resolve(currentFileDir, '..', '..');
}
```

---
