## TL;DR

The eval process is connected to the wrong MongoDB environment, so lookups for production runIds fail.

## What Broke and Why

**Observed error:** `Error: Issue solver run not found for runId: 3daa8451-d9fa-4b72-b3f5-82e880115e76`

### Causal Chain

**1.** `MONGO_URI` differs between eval and prod configs.

**2.** Other eval cases in the same file pass.

## Fix

- Point the eval runner at the production read replica.

---

## Metrics

**Performance:**
- Total latency: 415 seconds
- Token usage: 392,272 + 17,203 = 409,475 tokens

**Tool Usage:**
- Top 3 most-used tools: Grep, Agent, Bash
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
