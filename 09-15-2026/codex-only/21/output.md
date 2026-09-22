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
- Total latency: 304 seconds
- Token usage: 249,726 + 23,267 = 272,993 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, update_plan, shell
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
