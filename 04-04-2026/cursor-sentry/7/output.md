## TL;DR
Race condition in Pyodide singleton initialization: `pyodideInstance` is assigned mid-initialization (after `loadPyodide()` but before filesystem mount and `sys.path` setup), so concurrent callers see a non-null instance, skip waiting, and hit `ModuleNotFoundError: No module named 'foam_wrapper'`.

## What Broke and Why

The exception-polling worker (`exception-polling.worker.ts`) processes jobs with concurrency 5, meaning up to 5 jobs run simultaneously. Each job eventually calls `processFoamLogBatch()` in `drain3-pyodide.service.ts`, which calls `await initializePyodide()` before running Python code via Pyodide.

The `initializePyodide()` function is designed as a lazy singleton with two guards:

```typescript
async function initializePyodide(): Promise<void> {
    if (pyodideInstance) { return; }              // Guard 1: already initialized
    if (initializationPromise) { return initializationPromise; } // Guard 2: in progress
    initializationPromise = (async () => {
        // ...
        pyodideInstance = await loadPyodide(...);  // ← BUG: assigned HERE
        // ... more async setup steps follow ...
        await instance.loadPackage('micropip');
        await instance.runPythonAsync(`import micropip; ...`);
        instance.mountNodeFS('drain3_vendor', drain3VendorPath);
        await instance.runPythonAsync(`sys.path.insert(0, '/home/pyodide/drain3_vendor')`);
        await instance.runPythonAsync(`from foam_wrapper import get_wrapper`);  // verification
    })();
    return initializationPromise;
}
```

**The bug:** `pyodideInstance` is assigned on line 145 when `loadPyodide()` resolves, but the full initialization (installing micropip, mounting the vendor directory, configuring `sys.path`) requires several more async steps. Each `await` yields to the event loop, allowing other concurrent jobs to execute.

**The race condition sequence:**

1. **Job A** calls `initializePyodide()`. Both guards are false. It sets `initializationPromise` and begins the async initialization. `loadPyodide()` completes → `pyodideInstance` is now assigned (non-null).
2. At the next `await` (e.g., `loadPackage('micropip')`), the event loop runs **Job B**.
3. **Job B** calls `initializePyodide()`. Guard 1 (`if (pyodideInstance)`) is **true** → returns immediately, skipping Guard 2 entirely.
4. **Job B** proceeds to `pyodideInstance.runPythonAsync('from foam_wrapper import process_log_batch ...')`.
5. But `sys.path` doesn't yet contain `/home/pyodide/drain3_vendor` (mounting and path setup haven't happened yet).
6. Python raises `ModuleNotFoundError: No module named 'foam_wrapper'`.
7. This propagates up through `processBatch` → `processExceptionPollingJob`, which wraps it as `Error: Failed to process batch for {customerId}:{serviceId}: Traceback...ModuleNotFoundError...`.

**Evidence from Sentry:** On March 2, 2026, five errors from the same server (`ip-172-31-39-14`) hit within 9 seconds (02:26:32–02:26:41), all for different services (`mewtwo`, `mono`, `webapp-browser`, `porygon-browser`) but the same customer (`674e5380f251f603c5ef1847`). The app started at `02:13:25`. This burst pattern is consistent with multiple concurrent polling jobs racing through initialization after the worker starts processing a batch of scheduled jobs. The issue has 13,909 total occurrences since Nov 2025, confirming it happens on every deployment/restart.

## Fix

In `mewtwo/src/services/drain3-pyodide.service.ts`, use a local variable during initialization and only assign to the module-level `pyodideInstance` **after all setup is complete**:

```typescript
// Start initialization
initializationPromise = (async () => {
    log().info('Initializing Pyodide runtime...');

    const { loadPyodide } = await import('pyodide');

    // Use a LOCAL variable — do NOT assign to pyodideInstance yet
    const instance = await loadPyodide(
        process.env.PYODIDE_INDEX_URL ? { indexURL: process.env.PYODIDE_INDEX_URL } : undefined,
    );

    log().info('Pyodide runtime loaded, installing micropip...');
    await instance.loadPackage('micropip');

    log().info('micropip loaded, installing drain3 from vendor folder...');
    const projectRoot = getProjectRoot();
    const drain3VendorPath = path.join(projectRoot, 'vendor', 'drain3');
    log().info(`drain3 vendor path: ${drain3VendorPath}`);

    await instance.runPythonAsync(`
        import micropip
        await micropip.install(['jsonpickle', 'cachetools'])
    `);

    log().info('drain3 dependencies installed');

    instance.mountNodeFS('drain3_vendor', drain3VendorPath);
    log().info(`Mounted ${drain3VendorPath} at /home/pyodide/drain3_vendor using mountNodeFS`);

    await instance.runPythonAsync(`
        import sys
        sys.path.insert(0, '/home/pyodide/drain3_vendor')
    `);

    log().info('Added /home/pyodide/drain3_vendor to Python path');

    await instance.runPythonAsync(`
        from drain3 import TemplateMiner
        from drain3.template_miner_config import TemplateMinerConfig
        from foam_wrapper import get_wrapper
        print("drain3 and foam_wrapper loaded successfully from mounted directory")
    `);

    // ONLY assign to the global singleton AFTER all setup is complete
    pyodideInstance = instance;

    log().info('Pyodide initialization complete with drain3 and foam_wrapper');
})();
```

This ensures that the `if (pyodideInstance)` early-return guard in `initializePyodide()` only triggers when the instance is **fully** initialized. Concurrent callers will correctly fall through to Guard 2 (`if (initializationPromise)`) and await the in-progress initialization.

---
