## TL;DR

The `Unknown expression identifier 'Attributes'` ClickHouse error was caused by the AI agent's system prompt providing no schema documentation for the `otel_logs` table — only a 4-column example query — causing the LLM to hallucinate `Attributes` as a valid column name when the actual Map-typed columns are `LogAttributes`, `ResourceAttributes`, and `ScopeAttributes`. In this specific trace, the agent self-corrected on the next attempt, but the job ultimately failed due to two compounding issues: unbounded context accumulation (no message pruning) causing malformed LLM output, and a stale Vertex AI fallback model ID (`claude-3-7-sonnet@20250219`) returning 404 that blocked all recovery attempts.

---

## What Broke and Why

### Layer 1: The Reported Error — Schema Hallucination

The BaseAgent's `buildSystemPrompt()` in `/repo/mewtwo/src/agents/base.agent.ts` provides the LLM with only a bare 4-column example query for `otel_logs`:

```sql
SELECT Body, Timestamp, ServiceName, SeverityText
FROM otel_logs
WHERE Body LIKE '%error%'
AND Timestamp > now() - INTERVAL 24 HOUR
ORDER BY Timestamp DESC
LIMIT 50
```

The system prompt and the `queryOtel` tool description contain **zero schema documentation** — no column list, no data types, no mention of the Map-typed attribute columns (`LogAttributes`, `ResourceAttributes`, `ScopeAttributes`) or their accessor syntax.

When the issue-solver agent started investigating the "no space" error for job `foam-681` (trace `acacf6df3ca6fc48f31c48c6cbaf8808`), it needed to query log attributes. Without schema grounding, the LLM analogized from the OpenTelemetry specification's generic `attributes` concept and generated:

```sql
SELECT Body, Timestamp, ServiceName, SeverityText, Attributes
FROM otel_logs
WHERE Body LIKE '%no spac%'
AND Timestamp > now() - INTERVAL 24 HOUR
ORDER BY Timestamp DESC LIMIT 50
```

ClickHouse rejected this at `21:56:26.370` with:
> `Unknown expression identifier 'Attributes' in scope SELECT ... Maybe you meant: [Body, Timestamp, ServiceName, SeverityText, ...]`

The `query-otel.tool.ts` `executeQuery()` function performs no schema validation — it passes the raw LLM-generated SQL directly to ClickHouse via `client.query({ query, format: 'JSONEachRow' })`.

This is the specific error captured in span `07bd266cc12dc279`.

### Layer 2: Context Accumulation → Malformed LLM Output

Although the agent self-corrected the `Attributes` mistake on the next attempt (using `LogAttributes` instead), several subsequent queryOtel calls returned 50,034-character truncated results containing raw `rrweb` DOM session replay blobs — massive payloads with no diagnostic value. These accumulated in the `messages[]` array without any pruning:

- `21:56:29` — queryOtel result: 50,034 chars (truncated), `rrweb` DOM data
- `21:56:30` — queryOtel result: 50,034 chars (truncated), `rrweb` DOM data  
- `21:56:37` — queryOtel result: 50,034 chars (truncated), `rrweb` DOM data

The `base.agent.ts` loop has **no message pruning, no token counting, and no conversation compaction**. By message index 31 (~200K+ accumulated chars), the LLM generated a malformed `executeCommands` tool input containing XML-like fragments instead of valid JSON:

```
{"commands":[{"keystrokes": "grep ... "}]}</parameter>\n</invoke>": ""}
```

The Anthropic API rejected this at `21:58:27.382` with:
> `messages.31.content.1.tool_use.input: Input should be a valid dictionary`
> (`x-should-retry: false`)

### Layer 3: Defunct Vertex AI Fallback Blocks Recovery

The nudge mechanism triggered to recover the failed agent, falling back to the `bubblesModel` registered under `bubbles:agent` in `/repo/mewtwo/src/llms/ai-sdk/registry.ts`. This model includes `anthropic(CLAUDE_SONNET_37)` as its third-tier fallback, which maps to Vertex AI model `claude-3-7-sonnet@20250219` via the `ANTHROPIC_TO_VERTEX` mapping at line 111.

This model version was removed from the Vertex AI catalog (`locations/global`) and returns 404:
> `Publisher Model projects/foam-ai-452314/locations/global/publishers/anthropic/models/claude-3-7-sonnet@20250219 was not found`

The error was marked `isRetryable: false`, preventing the Bedrock third-tier fallback from firing. With all nudge paths exhausted, the agent terminated at `21:58:35.424` with `"No output generated"` and the job failed.

Telemetry confirms this Vertex AI 404 is **systemic**: 806 identical errors across 397 distinct traces over the past 90 days.

---

## Fix

### Fix 1 (Root Cause of Reported Error): Add `otel_logs` Schema to System Prompt

In `/repo/mewtwo/src/agents/base.agent.ts`, `buildSystemPrompt()` should document the actual `otel_logs` table schema, especially the Map-typed attribute columns and their ClickHouse accessor syntax:

```typescript
// In buildSystemPrompt() — add to the queryOtel tool documentation:
`### otel_logs Schema (key columns)
| Column | Type | Notes |
|---|---|---|
| Body | String | Log message text |
| Timestamp | DateTime64(9) | Use with INTERVAL syntax |
| ServiceName | String | Service identifier |
| SeverityText | String | e.g., 'ERROR', 'INFO' |
| LogAttributes | Map(String, String) | App-level attributes — access as LogAttributes['key'] |
| ResourceAttributes | Map(String, String) | Resource metadata — access as ResourceAttributes['key'] |
| ScopeAttributes | Map(String, String) | Instrumentation scope attributes |
| TraceId | String | Hex trace ID |
| SpanId | String | Hex span ID |

Example attribute query:
SELECT Body, LogAttributes['run_id'] AS runId, Timestamp
FROM otel_logs
WHERE LogAttributes['run_id'] = '...'
AND Timestamp > now() - INTERVAL 24 HOUR
ORDER BY Timestamp DESC LIMIT 50`
```

**Why this fixes the chain**: With an explicit column list and Map accessor examples, the LLM has no reason to hallucinate `Attributes`. The bad SQL is never generated, ClickHouse never rejects it, and the error span `07bd266cc12dc279` would never occur.

### Fix 2 (Context Accumulation): Add Message Pruning / Tool Result Size Management

In `base.agent.ts`, implement context window management before the `streamText()` call:
1. **Truncate low-value tool results** at the source — `query-otel.tool.ts` should detect and strip `rrweb`/session-replay DOM blobs before returning results to the agent.
2. **Cap accumulated context** — prune or summarize older tool results when total estimated tokens exceed a threshold (e.g., 80K tokens), keeping the most recent N turns intact.

**Why this fixes the chain**: Prevents the unbounded context growth that degraded LLM structured-output quality and caused the malformed JSON at message index 31.

### Fix 3 (Defunct Fallback): Remove or Replace `CLAUDE_SONNET_37` from `bubblesModel` Fallback Chain

In `/repo/mewtwo/src/llms/ai-sdk/registry.ts`, remove `anthropic(CLAUDE_SONNET_37)` from the `bubblesModel` fallback chain (or replace it with a working model like `CLAUDE_HAIKU_35` whose Vertex mapping `claude-3-5-haiku@20241022` is current):

```typescript
// Current (broken):
const bubblesModel = createFallbackChain(
    [anthropic(CLAUDE_SONNET_4), anthropic(CLAUDE_HAIKU_45), anthropic(CLAUDE_SONNET_37)],
    'bubbles',
);

// Fixed:
const bubblesModel = createFallbackChain(
    [anthropic(CLAUDE_SONNET_4), anthropic(CLAUDE_HAIKU_45)],
    'bubbles',
);
```

**Why this fixes the chain**: Eliminates the 404 dead-end that has blocked agent recovery 806 times across 397 runs over 90 days. The nudge mechanism would have a viable fallback path, allowing agent recovery after the malformed-JSON failure.

---