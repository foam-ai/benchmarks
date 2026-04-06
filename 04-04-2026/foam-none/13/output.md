[Foam Trace ID: dde54b86e68f1eae0246d472db62bc7f] ## TL;DR

An eval worker child process hung for the full 2-hour timeout (7,200,000ms) without completing, triggering the `setTimeout`-based kill mechanism in `eval.worker.ts`. The root cause is that the worker has no progress-based watchdog to detect stuck child processes early — it relies solely on a hard wall-clock timeout — combined with architectural weaknesses in child process management (SIGTERM-only kill with no SIGKILL escalation, interval-based pipe reading that risks pipe buffer deadlock, and no process group killing).

## What Broke and Why

The `mewtwo` service's eval worker (`/app/mewtwo/src/workers/eval.worker.ts`) processes jobs from a BullMQ `eval-queue`. Each job spawns a child process to execute a shell command, wrapped in a Promise with a configurable timeout.

**Timeline from telemetry:**
- `app.start_time`: `2026-01-16T02:55:17.020Z` — the worker service started
- The eval job was picked up within ~51 seconds of service start
- The child process ran for the full 2-hour timeout window
- At `2026-01-16T04:56:07.859Z`, the timeout handler fired:

```typescript
// Handle timeout
if (timeout) {
    setTimeout(() => {
        clearInterval(flushTimer);
        child.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
}
```

The Promise rejected with `Error: Command timed out after 7200000ms`, was caught in the `catch` block, reported to Sentry (`mechanism.handled: true`), and the job was moved to failed state on the BullMQ queue (confirmed by sibling span `fail eval-queue`, 4.74ms).

**Why the child process hung for 2 hours:**

The telemetry shows no memory pressure (`device.free_memory`: 10.44 GB of 15.33 GB, `app.memory`: 409 MB) and Redis was responsive (`evalsha` span: 3.37ms), so resource exhaustion is not the cause. The child process either:

1. **Was stuck on a pipe buffer deadlock**: The code uses a `flushTimer` (`setInterval`) to periodically read child output rather than event-driven streaming (`child.stdout.on('data', ...)`). With piped stdio (the default for `spawn()`/`exec()`), Linux's 64KB pipe buffer can fill if the child writes faster than the interval drains it. When the buffer is full, the child's `write()` syscall blocks permanently, and the child hangs silently — a classic pipe buffer deadlock. The lack of any child output in OTEL spans is consistent with this scenario.

2. **Was running a legitimately long or stuck evaluation command**: The specific command is not captured in OTEL (only in Sentry extras via `{ extra: { jobId: job.id, command } }`), so we cannot determine the exact operation. The command could have been waiting on an external resource (network, API, database) or performing an extremely long computation.

**Architectural weaknesses that amplify the problem:**

- **No progress-based watchdog**: There is no mechanism to detect a child process that has stopped producing output. A process stuck at minute 1 wastes 119 minutes of compute before detection.
- **SIGTERM-only kill**: `child.kill()` sends SIGTERM (default signal), which can be ignored by the child process. There is no escalation to `SIGKILL` (signal 9) after a grace period, meaning the child may continue running as an orphan even after the timeout handler fires and the Promise rejects.
- **No process group killing**: `child.kill()` signals only the direct child PID. If the eval command spawns sub-processes (e.g., `bash -c "cmd1 | cmd2"`), those grandchild processes are not killed and become orphans.
- **Interval-based pipe reading**: The `flushTimer` approach creates windows where the pipe buffer can fill, especially if stderr is not being drained at all (only stdout being read would cause stderr to fill its 64KB buffer and block).

## Fix

**1. Add progress-based idle timeout** — detect and kill child processes that stop producing output:

```typescript
let lastOutputTime = Date.now();
const IDLE_TIMEOUT_MS = 300_000; // 5 minutes with no output

child.stdout?.on('data', (data) => {
    lastOutputTime = Date.now();
    outputBuffer += data.toString();
});
child.stderr?.on('data', (data) => {
    lastOutputTime = Date.now();
    stderrBuffer += data.toString();
});

const idleChecker = setInterval(() => {
    if (Date.now() - lastOutputTime > IDLE_TIMEOUT_MS) {
        clearInterval(idleChecker);
        clearInterval(flushTimer);
        killProcessGroup(child);
        reject(new Error(`Command idle for ${IDLE_TIMEOUT_MS}ms — no output detected`));
    }
}, 60_000);
```

This breaks the causal chain because a stuck child process (whether from pipe deadlock, network hang, or computation hang) would be detected within 5 minutes of becoming idle, rather than consuming the full 2-hour timeout.

**2. Switch from interval-based to event-driven pipe reading** to prevent pipe buffer deadlock:

```typescript
// Replace flushTimer-based reading with event-driven streaming
child.stdout?.on('data', (chunk) => { outputBuffer += chunk; });
child.stderr?.on('data', (chunk) => { stderrBuffer += chunk; });
// Keep flushTimer ONLY for periodic flushing of accumulated buffer to job.log()
```

**3. Add SIGKILL escalation and process group kill**:

```typescript
function killProcessGroup(child: ChildProcess) {
    try {
        process.kill(-child.pid!, 'SIGTERM'); // Kill entire process group
    } catch { child.kill('SIGTERM'); }
    setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    }, 5000);
}
```

Spawn with `{ detached: true }` to create a process group, enabling clean termination of all sub-processes.

The primary fix (#1 + #2) prevents the observed failure by: (a) eliminating the pipe buffer deadlock risk through event-driven reading, and (b) detecting stuck processes within minutes rather than hours. Fix #3 ensures that killed processes actually die, preventing orphan resource leaks.

---
