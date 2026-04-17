[Foam Trace ID: ce97906d7c905f2ca5f142bd588b6889] ## TL;DR

A `MultiHypothesisResearchAgent` evaluation run OOM-killed a ClickHouse query after issuing a `FULL OUTER JOIN` between `otel_logs` and `otel_traces` on `DATE(Timestamp)` — a near-Cartesian product with leading-wildcard `LIKE` scans — driving the server's RSS to 28.74 GiB against a 28.80 GiB ceiling. This happened because (1) the `queryOtel` tool has no `max_memory_usage` per-query guard, and (2) the agent was forced into over-reliance on ClickHouse queries due to a separate bug in `executeCommands` that left a Docker container in a broken partial-initialization loop, rendering all code-exploration fallback unavailable for the entire run.

---

## What Broke and Why

### Bug 1 (Triggering Condition): `executeCommands` Docker 409 Partial-Initialization Loop

The agent's `executeCommands` tool initializes a Docker container via `initializeTerminal()` in `mewtwo/src/agents/tools/execute-commands.tool.ts`. The function is guarded by a mutex and sets `initialized = true` only after all setup steps complete:

```typescript
const initializeTerminal = async (): Promise<void> => {
    await initMutex.runExclusive(async () => {
        if (initialized) return;

        // Step 3: container CREATED AND STARTED in Docker daemon
        container = new DockerContainer(...);

        // Step 4–6: git config exec, tmux session start...
        // ← If ANY of these throw, initialized stays false
        // ← But the container already exists in Docker

        initialized = true;  // Never reached on failure
    });
};
```

If any step after `createContainer()` throws, the Docker container `base-agent-<sessionId>` is left alive in the daemon while `initialized` remains `false`. The `execute` handler catches the error and returns `{ success: false }` **without cleaning up the partial container**:

```typescript
execute: async ({ commands }) => {
    try {
        await initializeTerminal();  // throws on 2nd+ attempt → 409
    } catch (error) {
        // ← No container rollback here
        return { success: false, error: errorMsg };
    }
}
```

Every subsequent `executeCommands` call re-enters `initializeTerminal`, re-attempts `createContainer` with the **same name** (`base-agent-${ctx.sessionId}`), and receives **Docker 409 Conflict: container name already in use**. This is confirmed by spans s7–s21 in trace `d103a5b3b6e73484dfb39170cf1a554c`, which all failed with this error.

**Impact:** The agent's entire code-exploration capability was broken for the run. Span s44 eventually succeeded (likely after the stale container was externally reaped), but by then the agent had already pivoted to issuing all investigation work via ClickHouse queries — 15+ successive `queryOtel` calls — including progressively broader analytical queries.

---

### Bug 2 (Root Cause of OOM): `queryOtel` Has No `max_memory_usage` Guard

The `queryOtel` tool in `mewtwo/src/agents/tools/query-otel.tool.ts` (and the shared `connect.ts`) applies exactly one server-side constraint on query execution:

```typescript
const result = await client.query({
    query,
    format: 'JSONEachRow',
    clickhouse_settings: { max_execution_time: 30 },  // ← only constraint
});
```

There is **no `max_memory_usage`, no `max_bytes_to_read`, no `max_rows_to_read`, and no `result_overflow_mode`**. The only client-side guardrail is a LIMIT ≤ 100 rows enforcement on the *returned* result set — which does nothing to limit how much data ClickHouse must **scan and materialize** to produce those rows.

---

### The Fatal Query: Near-Cartesian Product on Two Billion-Row Tables

Forced to use only ClickHouse queries, the agent eventually submitted a "final verification" temporal correlation query:

```sql
SELECT 
    DATE(t1.Timestamp) as error_date,
    COUNT(DISTINCT CASE WHEN t1.Body LIKE '%Solution result is empty for runId%' THEN 1 END) as backend_empty_solution_errors,
    COUNT(DISTINCT CASE WHEN t2.StatusMessage LIKE '%has an empty solution string%' THEN 1 END) as frontend_empty_solution_errors
FROM otel_logs t1
FULL OUTER JOIN otel_traces t2 ON DATE(t1.Timestamp) = DATE(t2.Timestamp)
WHERE (t1.Body LIKE '%Solution result is empty for runId%' OR t2.StatusMessage LIKE '%has an empty solution string%')
    AND t1.Timestamp >= '2026-01-20 00:00:00'
GROUP BY error_date
ORDER BY error_date DESC
LIMIT 10
```

Three compounding performance defects in this query:

1. **`FULL OUTER JOIN` on `DATE(Timestamp)`** — joining on a day-truncated timestamp creates an O(n × m) Cartesian product for every day in the range. The `otel_logs` table part being read spanned granules `20346–277777` (~257,000 granules × 8,192 rows = ~2.1 billion rows in a single part alone).

2. **Leading-wildcard `LIKE '%...'` patterns** on `Body` and `StatusMessage` — cannot use any MergeTree index, forcing a full column scan. The `Body` column had `avg_value_size_hint = 880.08` bytes (1,046 chars average) per row, confirmed in the ClickHouse error payload.

3. **No partition pruning on `otel_traces`** — the `WHERE` clause only constrains `t1.Timestamp`, leaving `otel_traces` (`t2`) effectively unfiltered before the join.

ClickHouse read 528+ granules (4.3+ million rows) before RSS hit 28.74 GiB at 7.25 seconds. OvercommitTracker selected this query for termination when it attempted to allocate another 16.10 MiB chunk against a 28.80 GiB server ceiling:

> `(total) memory limit exceeded: would use 28.74 GiB (attempt to allocate chunk of 16.10 MiB bytes), current RSS: 28.81 GiB, maximum: 28.80 GiB. OvercommitTracker decision: Query was selected to stop`

---

### Full Causal Chain

```
executeCommands partial init bug
  → Docker container left running after failed setup step
  → initializeTerminal re-attempts with same name → 409 Conflict loop (spans s7–s21)
  → Agent unable to do code exploration via shell commands
  → Agent falls back to 15+ successive ClickHouse queryOtel calls
  → queryOtel has no max_memory_usage constraint
  → Agent-generated FULL OUTER JOIN on DATE(Timestamp) with wildcard LIKE scans
  → ClickHouse materializes near-Cartesian product of billion-row tables
  → ClickHouse RSS reaches 28.74 GiB / 28.80 GiB limit
  → OvercommitTracker kills query → OOM error thrown
```

---

## Fix

There are two independent bugs to fix. Bug 2 directly causes the OOM; Bug 1 amplifies the likelihood of it being triggered.

### Fix 1 (Direct OOM Prevention): Add `max_memory_usage` to `queryOtel` queries

In `mewtwo/src/agents/tools/query-otel.tool.ts` (and/or `mewtwo/src/clients/clickhouse/connect.ts`), add a per-query memory cap:

```typescript
const result = await client.query({
    query,
    format: 'JSONEachRow',
    clickhouse_settings: {
        max_execution_time: 30,
        max_memory_usage: 2_000_000_000,   // 2 GiB per query hard cap
        max_bytes_to_read: 10_000_000_000, // 10 GiB bytes scanned
        read_overflow_mode: 'throw',
        memory_overflow_mode: 'throw',
    },
});
```

This breaks the causal chain at the mechanism level: even if the agent generates a `FULL OUTER JOIN` query against billion-row tables, ClickHouse will throw a per-query overflow error (returned to the agent as a structured tool error) rather than consuming the server's entire memory budget and triggering OvercommitTracker. The agent can then retry with a narrower query.

As a complementary defense, add pre-execution detection of known dangerous patterns to the tool's input validation:

```typescript
const DANGEROUS_PATTERNS = [
    /FULL\s+OUTER\s+JOIN/i,
    /CROSS\s+JOIN/i,
    /LIKE\s+'%[^%]/i,  // leading-wildcard LIKE
    /toString\s*\(\s*SpanAttributes/i,
];
```

### Fix 2 (Contributing Bug): Rollback partial container creation in `executeCommands`

In `mewtwo/src/agents/tools/execute-commands.tool.ts`, wrap the post-creation setup steps in a try/catch that removes the container before rethrowing:

```typescript
// Inside initMutex.runExclusive(), after container creation:
try {
    await container.exec(['git', 'config', '--global', 'safe.directory', '*']);
    tmuxSession = new BubblesTmuxSession({ ... });
    await tmuxSession.start();
    initialized = true;
} catch (initError) {
    // Rollback: remove the partially-created container so the next
    // executeCommands call can attempt a clean initialization
    try {
        await dockerClient.stopContainer(container.id);
    } catch (_) { /* best-effort */ }
    container = undefined;
    throw initError;
}
```

This breaks the 409 loop: if initialization fails after container creation, the container is cleaned up before `initMutex` is released, so the next call starts fresh. This restores the agent's code-exploration path and reduces over-reliance on ClickHouse queries.

---

**Alternative hypothesis considered and eliminated:** Concurrent load from other tenants was considered as a cause of ClickHouse RSS saturation. This was eliminated because the per-session evidence shows 15+ queries from this single agent run (with `toString(SpanAttributes)` scans on large map columns) were sufficient to approach the memory ceiling before the fatal query, and the token accumulation pattern (4.5K → 28.9K input tokens across 18 iterations, hitting 4M TPM rate limits) confirms a single-run resource exhaustion pattern rather than external contention.


---
