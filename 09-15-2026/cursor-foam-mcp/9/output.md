## TL;DR

An Anthropic API rate-limit incident caused 429s; the fallback to Bedrock failed because Bedrock quotas were also low at the time. The retry policy lacks backoff.

## What Broke and Why

**Observed error:** `RateLimitError: This request would exceed your organization's rate limit of 4,000,000 tokens per minute`

`query-otel` was used to pull the logs and spans for the failing trace from ClickHouse before reading the code.

### Causal Chain

**1.** Both providers returned rate-limit errors within the same minute.

**2.** No backoff between the primary and fallback attempts.

## Fix

- Add exponential backoff and request a higher Bedrock quota.

---

## Metrics

**Performance:**
- Total latency: 556 seconds
- Token usage: 433,786 + 7,641 = 441,427 tokens

**Tool Usage:**
- Top 3 most-used tools: codebase_search, grep, list_dir
- Top 3 most USEFUL tools: query-otel (input: otel_logs/otel_traces around the trace ID) read_file (input: the throwing function and its callers) grep (input: the error string across the repo)
