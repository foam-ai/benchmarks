# 09-15-2026 Experiments — Claude Code vs. Foam

> **Illustrative run.** The `output.md` files and scores in this directory are mocked to show the
> shape of the results and the trend the team observed. They are not verbatim agent transcripts.
> Treat the numbers as directional, not as a measured result.

- Run date: `09-15-2026`
- Harness under test: **Claude Code** (CLI, single-pass, no user intervention), replacing the Cursor
  conditions used in April
- Agent model for the Claude Code conditions: `claude-fable-5-1` (Fable 5.1)
- Judges: `claude-fable-5-1` (Fable 5.1) and `gpt-5-codex` (Codex), run independently
- Answer key: shared with [`../04-04-2026/answers/`](../04-04-2026/answers/)

## Models breakdown

### Agents

| Condition                | Harness     | Agent model            | Extra tools                                   |
| ------------------------ | ----------- | ---------------------- | --------------------------------------------- |
| `claude-code-only`       | Claude Code | `claude-fable-5-1`     | none (Read, Grep, Glob, Bash, Agent)          |
| `claude-code-sentry`     | Claude Code | `claude-fable-5-1`     | Sentry MCP (`get_sentry_resource`, `search_issue_events`) |
| `claude-code (Foam MCP)` | Claude Code | `claude-fable-5-1`     | Foam MCP (`query-otel`)                       |
| `foam`                   | Foam agent  | `repr-qo-b-rlm` config | Foam's own telemetry and code tooling         |

### Judges

| Judge      | Model              | Provider  | Role                                   |
| ---------- | ------------------ | --------- | -------------------------------------- |
| Fable 5.1  | `claude-fable-5-1` | Anthropic | Primary; same model family as the agents |
| Codex      | `gpt-5-codex`      | OpenAI    | Independent second opinion             |

Because the Claude Code conditions run on Fable 5.1 and Fable 5.1 is also a judge, Codex is kept as
a cross-vendor check. An eval counts as correct only when **both** judges answer "Yes" (consensus).
Per-judge verdicts are stored next to every output.

## Results

| Condition                | Consensus | Accuracy | Fable 5.1 alone | Codex alone    | 04-04 Cursor equivalent (GPT-4o) |
| ------------------------ | --------: | -------: | --------------: | -------------: | -------------------------------: |
| `claude-code-sentry`     |     11/22 |    50.0% |   13/22 (59.1%) |  11/22 (50.0%) |                     9/22 (40.9%) |
| `claude-code-only`       |     13/22 |    59.1% |   13/22 (59.1%) |  14/22 (63.6%) |                    12/22 (54.5%) |
| `claude-code (Foam MCP)` |     18/22 |    81.8% |   19/22 (86.4%) |  18/22 (81.8%) |                    14/22 (63.6%) |
| `foam`                   |     20/22 |    90.9% |   21/22 (95.5%) |  20/22 (90.9%) |                    18/22 (81.8%) |

Judge agreement: **83/88 (94.3%)**. The 5 splits are marked † below and all resolve to 0 under consensus.

### Takeaways

- **Same ordering as April.** Sentry MCP alone ≤ bare Claude Code < Claude Code + Foam MCP < Foam.
  Giving Claude Code the `query-otel` tool is worth **+23 points** over bare Claude Code under consensus,
  the largest single-tool gain we have measured. The full Foam agent is still the top condition.
- **Under the Fable judge, bare Claude Code and Claude Code + Sentry score the same (13/22).** Sentry
  context helps on incidents where the stack trace is the whole story (evals 0, 2, 16) but hurts on
  incidents where the Sentry issue points at a symptom rather than the cause (evals 7, 19, 22), where the
  agent anchors on Sentry breadcrumbs instead of reading the code. Codex is stricter on the Sentry outputs
  (11/22), which is where the consensus gap between the two comes from.
- **Higher accuracy than April across the board.** Part of this is the harness/model change
  (Claude Code on Fable 5.1 vs. Cursor on opus-4.6); part is judge behaviour. Both new judges accept an
  RCA that names the right underlying condition at a different level of abstraction, which GPT-4o
  sometimes marked as "different root cause".
- **The hard evals stayed hard.** Eval 9 (Anthropic TPM exhaustion from accumulated tool output) fails
  for every condition; eval 8 (the E11000 "not a bug" lock behaviour) trips every Claude Code
  condition; eval 13 (ECS containers without `.git`) still fails outside `foam`.
- **Judges disagree only on partial diagnoses.** All five splits are outputs that identified the right
  area and part of the mechanism but hedged toward a second cause.

## Per-eval results

Consensus `score.txt`; † = judges split (see `score-fable.txt` / `score-codex.txt`).

| Eval | `claude-code-sentry` | `claude-code-only` | `claude-code (Foam MCP)` | `foam` |
| ---: | -------------------: | -----------------: | -----------------------: | -----: |
|    0 |                  100 |                  0 |                        0 |    100 |
|    1 |                  100 |                100 |                      100 |    100 |
|    2 |                  100 |                100 |                      100 |    100 |
|    3 |                  100 |                100 |                      100 |    100 |
|    4 |                    0 |                  0 |                      100 |    100 |
|    5 |                  100 |                100 |                      100 |    100 |
|    6 |                  100 |                100 |                      100 |    100 |
|    7 |                    0 |                100 |                      100 |    100 |
|    8 |                    0 |                  0 |                        0 |    100 |
|    9 |                    0 |                  0 |                        0 |      0 |
|   10 |                  100 |                100 |                      100 |    100 |
|   11 |                  100 |                0 † |                      100 |    100 |
|   12 |                  100 |                100 |                      100 |    100 |
|   13 |                    0 |                  0 |                      0 † |    100 |
|   14 |                  100 |                100 |                      100 |    100 |
|   15 |                  100 |                100 |                      100 |    100 |
|   16 |                  0 † |                100 |                      100 |    100 |
|   17 |                    - |                  - |                        - |      - |
|   18 |                    0 |                  0 |                      100 |    100 |
|   19 |                    0 |                  0 |                      100 |    100 |
|   20 |                  0 † |                100 |                      100 |    100 |
|   21 |                    0 |                  0 |                      100 |    100 |
|   22 |                    0 |                100 |                      100 |    0 † |

### Judge splits

| Cell                          | Fable | Codex | Why they disagreed (summary)                                                        |
| ----------------------------- | ----: | ----: | ----------------------------------------------------------------------------------- |
| `claude-code-sentry` / 16     |   100 |     0 | Output names the deployment-URL path but also blames the API version.               |
| `claude-code-sentry` / 20     |   100 |     0 | Output finds the stale worktree registry entry but adds a concurrency hypothesis.   |
| `claude-code-only` / 11       |     0 |   100 | Output says the job was mis-enqueued but frames a schema change as a co-cause.      |
| `claude-code (Foam MCP)` / 13 |   100 |     0 | Output finds the missing `.git` but under-specifies the swallowed pre-flight error. |
| `foam` / 22                   |   100 |     0 | Output identifies the non-string tool result but not the PR #401 schema change.     |

## Procedure

Same as [`04-04-2026`](../04-04-2026/README.md), with Claude Code in place of Cursor:

1. Each eval was initialised from the repository and commit SHA in its eval prompt, in an isolated git worktree.
2. Pre-existing eval directories were removed from the worktree.
3. Exactly one `claude -p` run (or one Foam run) was launched per eval prompt, in parallel, with no
   root-cause information and no user interaction.
4. Reports were written to `./[experiment]/[index]/output.md`.
5. Outputs were scored afterward against the shared answer key using `scorer.ts`.

Conditions:

- `claude-code-only`: Claude Code with only the eval prompt and the repository worktree.
- `claude-code-sentry`: same, with Sentry MCP permitted.
- `claude-code-foam-mcp` (`claude-code (Foam MCP)`): same, with Foam's `query-otel` tool.
- `foam`: the Foam agent, no user intervention.

## Scoring

```bash
cd 09-15-2026
npm install
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npx tsx scorer.ts [experiment]
```

`scorer.ts` sends each output to both judges with the same rubric used in April (same incident,
same precise root cause, same fix), writes `score-fable.txt` and `score-codex.txt`, and writes the
consensus to `score.txt`. `results.json` is a machine-readable dump of every verdict, including the
agent and judge models.

## Folder structure

- `[experiment]/[index]/output.md` — agent report (mocked in this run)
- `[experiment]/[index]/score.txt` — consensus score (100 / 0)
- `[experiment]/[index]/score-fable.txt`, `score-codex.txt` — per-judge scores
- `results.json` — all verdicts plus agent/judge models
- `scorer.ts` — dual-judge scoring script
