# 09-15-2026 Experiments

> **Illustrative run.** The `output.md` files and scores in this directory are mocked to show the
> shape of the results and the trend the team observed. They are not verbatim agent transcripts.
> Treat the numbers as directional, not as a measured result.

- Run date: `09-15-2026`
- Agent model: `opus-4.6` (unchanged from `04-04-2026` for comparability)
- Judges: `claude-fable-5-1` (Fable 5.1) and `gpt-5-codex` (Codex), run independently
- Answer key: shared with [`../04-04-2026/answers/`](../04-04-2026/answers/)

## What changed vs. 04-04-2026

The 04-04 pass scored outputs with a single GPT-4o classifier. This pass re-ran the same 22 evals and
the same four agent configurations, but scored every output with **two** judges. An eval counts as
correct only when **both** judges answer "Yes" (consensus). Per-judge verdicts are kept alongside.

## Results

| Experiment          | Consensus | Accuracy | Fable 5.1 alone | Codex alone | 04-04 (GPT-4o) |
| ------------------- | --------: | -------: | --------------: | ----------: | -------------: |
| `cursor-sentry`     |     11/22 |    50.0% |    12/22 (54.5%) | 12/22 (54.5%) |  9/22 (40.9%) |
| `cursor-only`       |     14/22 |    63.6% |    15/22 (68.2%) | 15/22 (68.2%) | 12/22 (54.5%) |
| `cursor (Foam MCP)` |     17/22 |    77.3% |    18/22 (81.8%) | 17/22 (77.3%) | 14/22 (63.6%) |
| `foam`              |     20/22 |    90.9% |    21/22 (95.5%) | 20/22 (90.9%) | 18/22 (81.8%) |

Judge agreement: **82/88 (93.2%)**. The 6 splits are marked † below and all resolve to 0 under consensus.

### Takeaways

- **Same ordering as 04-04.** `cursor-sentry` < `cursor-only` < `cursor (Foam MCP)` < `foam`. Access to
  Foam telemetry (`query-otel`) is still worth ~+14 points over the Cursor baseline, and the full
  Foam agent is still the top condition.
- **Higher accuracy across the board (+9 to +14 points per condition).** Part of this is real
  improvement in the agents since April; part is judge behaviour. Fable and Codex are both more
  willing than GPT-4o to accept an RCA that names the right underlying condition at a different level
  of abstraction, which GPT-4o sometimes marked as "different root cause".
- **The hard evals stayed hard.** Eval 9 (Anthropic TPM exhaustion from accumulated tool output) fails
  for every condition; eval 8 (the E11000 "not a bug" lock behaviour) still trips every Cursor
  condition; eval 13 (ECS containers without `.git`) still fails outside `foam`.
- **Judges disagree mostly on partial diagnoses.** All six splits are outputs that identified the right
  area and part of the mechanism but hedged toward a second cause (e.g. eval 16, eval 18, eval 22).

## Per-eval results

Consensus `score.txt`; † = judges split (see `score-fable.txt` / `score-codex.txt`).

| Eval | `cursor-sentry` | `cursor-only` | `cursor (Foam MCP)` | `foam` |
| ---: | --------------: | ------------: | ------------------: | -----: |
|    0 |             100 |             0 |                   0 |    100 |
|    1 |             100 |           100 |                 100 |    100 |
|    2 |             100 |           100 |                 100 |    100 |
|    3 |             100 |           100 |                 100 |    100 |
|    4 |               0 |             0 |                 100 |    100 |
|    5 |             100 |           100 |                 100 |    100 |
|    6 |             100 |           100 |                 100 |    100 |
|    7 |               0 |           100 |                 100 |    100 |
|    8 |               0 |             0 |                   0 |    100 |
|    9 |               0 |             0 |                   0 |      0 |
|   10 |             100 |           100 |                 100 |    100 |
|   11 |             100 |           0 † |                 100 |    100 |
|   12 |             100 |           100 |                 100 |    100 |
|   13 |               0 |             0 |                 0 † |    100 |
|   14 |             100 |           100 |                 100 |    100 |
|   15 |             100 |           100 |                 100 |    100 |
|   16 |             0 † |           100 |                   0 |    100 |
|   17 |               - |             - |                   - |      - |
|   18 |               0 |           0 † |                 100 |    100 |
|   19 |               0 |           100 |                 100 |    100 |
|   20 |             0 † |           100 |                 100 |    100 |
|   21 |               0 |             0 |                 100 |    100 |
|   22 |               0 |           100 |                 100 |    0 † |

### Judge splits

| Cell                    | Fable | Codex | Why they disagreed (summary)                                                        |
| ----------------------- | ----: | ----: | ----------------------------------------------------------------------------------- |
| `cursor-sentry` / 16    |     0 |   100 | Output names the deployment-URL path but also blames the API version.               |
| `cursor-sentry` / 20    |   100 |     0 | Output finds the stale worktree registry entry but adds a concurrency hypothesis.   |
| `cursor-only` / 11      |     0 |   100 | Output says the job was mis-enqueued but frames a schema change as a co-cause.      |
| `cursor-only` / 18      |   100 |     0 | Output blames the join but does not isolate `DATE(Timestamp)` as the cross-product. |
| `cursor (Foam MCP)` / 13|   100 |     0 | Output finds the missing `.git` but under-specifies the swallowed pre-flight error. |
| `foam` / 22             |   100 |     0 | Output identifies the non-string tool result but not the PR #401 schema change.     |

## Procedure

Same as [`04-04-2026`](../04-04-2026/README.md):

1. Each eval was initialised from the repository and commit SHA in its eval prompt, in an isolated git worktree.
2. Pre-existing eval directories were removed from the worktree.
3. Exactly one agent was launched per eval prompt, in parallel, with no root-cause information.
4. Reports were written to `./[experiment]/[index]/output.md`.
5. Outputs were scored afterward against the shared answer key using `scorer.ts`.

The four conditions are unchanged:

- `cursor-only`: Cursor with only the eval prompt and the repository worktree.
- `cursor-sentry`: same, with Sentry MCP permitted.
- `cursor-foam-mcp` (`cursor (Foam MCP)`): same, with Foam's `query-otel` tool.
- `foam`: the Foam agent, no user intervention.

## Scoring

```bash
cd 09-15-2026
npm install
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npx tsx scorer.ts [experiment]
```

`scorer.ts` sends each output to both judges with the same rubric used in April (same incident,
same precise root cause, same fix), writes `score-fable.txt` and `score-codex.txt`, and writes the
consensus to `score.txt`. `results.json` is a machine-readable dump of every verdict.

## Folder structure

- `[experiment]/[index]/output.md` — agent report (mocked in this run)
- `[experiment]/[index]/score.txt` — consensus score (100 / 0)
- `[experiment]/[index]/score-fable.txt`, `score-codex.txt` — per-judge scores
- `results.json` — all verdicts
- `scorer.ts` — dual-judge scoring script
