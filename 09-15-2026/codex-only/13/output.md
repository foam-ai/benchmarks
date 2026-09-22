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
- Total latency: 550 seconds
- Token usage: 282,790 + 19,135 = 301,925 tokens

**Tool Usage:**
- Top 3 most-used tools: update_plan, shell, read_file
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
