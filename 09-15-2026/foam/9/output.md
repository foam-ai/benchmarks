[Foam Trace ID: 6c836d93a15f64a570b382f67e6d20cd] ## TL;DR

An Anthropic API rate-limit incident caused 429s; the fallback to Bedrock failed because Bedrock quotas were also low at the time. The retry policy lacks backoff.

## What Broke and Why

**Observed error:** `RateLimitError: This request would exceed your organization's rate limit of 4,000,000 tokens per minute`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** Both providers returned rate-limit errors within the same minute.

**2.** No backoff between the primary and fallback attempts.

## Fix

- Add exponential backoff and request a higher Bedrock quota.


---
