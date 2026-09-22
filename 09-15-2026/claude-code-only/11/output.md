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
- Total latency: 409 seconds
- Token usage: 415,877 + 19,310 = 435,187 tokens

**Tool Usage:**
- Top 3 most-used tools: Agent, Read, Bash
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
