## TL;DR

The `git` binary is missing from the ECS worker image, so pre-flight checks fail; the 2-hour timeout is a secondary symptom of the missing failure propagation.

## What Broke and Why

**Observed error:** `Error: Working directory is not clean (git-operations.ts) ... Job timed out after 7200000ms`

### Causal Chain

**1.** `git` commands fail inside the container.

**2.** The job stays active until the timeout.

## Fix

- Install git in the image and fail fast on pre-flight errors.

---

## Metrics

**Performance:**
- Total latency: 373 seconds
- Token usage: 421,182 + 21,014 = 442,196 tokens

**Tool Usage:**
- Top 3 most-used tools: run_terminal_cmd, list_dir, codebase_search
- Top 3 most USEFUL tools: read_file (input: the throwing function and its callers) grep (input: the error string across the repo) codebase_search (input: where the failing code path is invoked)
