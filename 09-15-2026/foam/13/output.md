[Foam Trace ID: a2b5a950e1f30453e24ed8f9f2c8bc0b] ## TL;DR

Remote eval dispatch forwards `--sha` commands to ECS workers, but production containers are built artifacts with no `.git` directory, so `isWorkingDirectoryClean()` fails immediately; the failure is not propagated and the job idles until the 2-hour timeout.

## What Broke and Why

**Observed error:** `Error: Working directory is not clean (git-operations.ts) ... Job timed out after 7200000ms`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** `git status` inside the container errors with 'not a git repository'.

**2.** The pre-flight check's rejection is swallowed by the dispatcher, leaving the job in `active` until BullMQ's lock expires.

## Fix

- Skip or reimplement the `--sha` pre-flight in containerised workers and surface pre-flight failures as job failures.


---
