## TL;DR

An Anthropic API rate-limit incident caused 429s; the fallback to Bedrock failed because Bedrock quotas were also low at the time. The retry policy lacks backoff.

## What Broke and Why

**Observed error:** `RateLimitError: This request would exceed your organization's rate limit of 4,000,000 tokens per minute`

### Causal Chain

**1.** Both providers returned rate-limit errors within the same minute.

**2.** No backoff between the primary and fallback attempts.

## Fix

- Add exponential backoff and request a higher Bedrock quota.

---

## Metrics

**Performance:**
- Total latency: 407 seconds
- Token usage: 499,672 + 23,781 = 523,453 tokens

**Tool Usage:**
- Top 3 most-used tools: Read, Glob, Bash
- Top 3 most USEFUL tools: Read (input: the throwing function and its callers) Grep (input: the error string across the repo) Bash (input: git log/blame on the touched files)
