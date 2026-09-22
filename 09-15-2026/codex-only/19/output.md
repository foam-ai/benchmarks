## TL;DR

The GitHub App token used by `GitWorktreeService` lacks access to the target repository, and GitHub reports missing permissions as a 404.

## What Broke and Why

**Observed error:** `Error: remote: Repository not found. fatal: repository 'https://github.com/foam-ai/mewtwo.git/' not found`

### Causal Chain

**1.** GitHub returns 404 for both missing and unauthorised repositories.

**2.** Token scopes were recently rotated.

## Fix

- Grant the app installation access to the repository.

---

## Metrics

**Performance:**
- Total latency: 365 seconds
- Token usage: 259,173 + 21,824 = 280,997 tokens

**Tool Usage:**
- Top 3 most-used tools: update_plan, shell, read_file
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
