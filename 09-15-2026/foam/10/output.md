[Foam Trace ID: b15bf22116397a8df1181ee166bdef39] ## TL;DR

The `bubblesModel` fallback chain exhausted `CLAUDE_SONNET_4` and `CLAUDE_HAIKU_45` and fell through to `CLAUDE_SONNET_37`, which is routed to Vertex AI; project `foam-ai-452314` has no entitlement to that deprecated model, Vertex returns 404, and `FallbackModel.retry` treats 404 as retryable and loops.

## What Broke and Why

**Observed error:** `404 NOT_FOUND: Publisher Model `claude-3-7-sonnet@20250219` was not found`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** `ANTHROPIC_TO_VERTEX` still maps Sonnet 3.7 even though it was deprecated in Nov 2025 for new customers.

**2.** 404 is classified alongside 5xx as retryable in `FallbackModel`.

## Fix

- Remove Sonnet 3.7 from the fallback chain and treat 404 as terminal so the chain advances to the next provider.


---
