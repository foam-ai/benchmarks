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
- Total latency: 217 seconds
- Token usage: 401,696 + 13,682 = 415,378 tokens

**Tool Usage:**
- Top 3 most-used tools: Grep, Bash, Glob
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
