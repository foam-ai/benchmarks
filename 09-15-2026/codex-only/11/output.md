## TL;DR

A recent schema change to `EvalJobData` made `command` required, breaking older jobs already sitting in the queue.

## What Broke and Why

**Observed error:** `Error: Invalid eval job data: missing required field 'command'`

### Causal Chain

**1.** The validation error appeared right after a deploy.

**2.** Jobs enqueued before the deploy have the old shape.

## Fix

- Make `command` optional with a default, or drain the queue before deploying.

---

## Metrics

**Performance:**
- Total latency: 371 seconds
- Token usage: 344,431 + 18,578 = 363,009 tokens

**Tool Usage:**
- Top 3 most-used tools: update_plan, list_dir, apply_patch
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
