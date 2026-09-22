# 09-15-2026 Experiments — Claude Code vs. Codex

> **Illustrative run.** The `output.md` files and scores in this directory are mocked to show the
> shape of the results and the trend the team observed. They are not verbatim agent transcripts.
> Treat the numbers as directional, not as a measured result.

- Run date: `09-15-2026`
- Scorer: the `04-04-2026` GPT-4o classifier, unchanged (`scorer.ts` here is a copy that points at the
  shared answer key)
- Judge model: `gpt-4o`
- Answer key: shared with [`../04-04-2026/answers/`](../04-04-2026/answers/)

## What changed vs. 04-04-2026

Only the agent harness. Everything else is held fixed: same 22 evals, same answer key, same GPT-4o
scorer and rubric, same three tool setups (nothing, Sentry MCP, Foam MCP), and the same Claude model
as April for the Claude harness. Cursor from April is replaced by two CLI harnesses, **Claude Code** and
**Codex**, each run in all three tool setups.

## Models

| Condition                | Harness     | Agent model   | Extra tools                                               |
| ------------------------ | ----------- | ------------- | --------------------------------------------------------- |
| `claude-code-only`       | Claude Code | `opus-4.6`    | none (Read, Grep, Glob, Bash, Agent)                      |
| `claude-code-sentry`     | Claude Code | `opus-4.6`    | Sentry MCP (`get_sentry_resource`, `search_issue_events`) |
| `claude-code (Foam MCP)` | Claude Code | `opus-4.6`    | Foam MCP (`query-otel`)                                   |
| `codex-only`             | Codex       | `gpt-5-codex` | none (shell, read_file, apply_patch, update_plan)         |
| `codex-sentry`           | Codex       | `gpt-5-codex` | Sentry MCP (`get_sentry_resource`, `search_issue_events`) |
| `codex (Foam MCP)`       | Codex       | `gpt-5-codex` | Foam MCP (`query-otel`)                                   |

Judge: `gpt-4o` for every condition, as in April. Claude Code runs on `opus-4.6`, the same model the
April Cursor conditions used. Codex cannot run a Claude model, so it runs on its own `gpt-5-codex`;
the Codex rows therefore change both harness and model relative to April.

## Results

| Condition                | Score | Accuracy | 04-04 Cursor, same tool setup |
| ------------------------ | ----: | -------: | ----------------------------: |
| `claude-code (Foam MCP)` | 19/22 |    86.4% |                 14/22 (63.6%) |
| `codex (Foam MCP)`       | 18/22 |    81.8% |                 14/22 (63.6%) |
| `claude-code-only`       | 14/22 |    63.6% |                 12/22 (54.5%) |
| `codex-only`             | 13/22 |    59.1% |                 12/22 (54.5%) |
| `claude-code-sentry`     | 12/22 |    54.5% |                  9/22 (40.9%) |
| `codex-sentry`           | 11/22 |    50.0% |                  9/22 (40.9%) |

### Takeaways

- **Same trend as April, in both harnesses.** Sentry MCP alone < bare harness < harness + Foam MCP.
  Giving the agent `query-otel` is worth **+23 points** for both Claude Code and Codex, by far the
  largest single-tool gain in either harness.
- **Claude Code edges out Codex in every tool setup, by exactly one eval.** With Foam MCP (19 vs 18)
  the difference is eval 0, where Claude Code connected the `query-otel` trace to the
  `solverResult`/`result` property mismatch and Codex stopped at the empty S3 object.
- **Both CLI harnesses beat Cursor on the same model and scorer.** Claude Code on `opus-4.6` gains
  2 to 5 evals over Cursor on `opus-4.6` per setup, with the scorer held fixed, so the lift for the
  Claude rows is attributable to the harness. The Codex rows change model as well, so their lift
  cannot be split between harness and model.
- **Sentry MCP still underperforms the bare harness.** It helps on incidents where the stack trace is the
  whole story (evals 0, 2, 16) but hurts where the Sentry issue points at a symptom rather than the cause
  (evals 19, 21, 22), where both harnesses anchor on Sentry breadcrumbs instead of reading the code.
- **The hard evals stayed hard.** Evals 8 (the E11000 "not a bug" lock behaviour), 9 (Anthropic TPM
  exhaustion from accumulated tool output) and 13 (ECS containers without `.git`) fail in every
  condition, as they did for every Cursor condition in April.

## Per-eval results

From `score.txt`:

| Eval | `claude-code-sentry` | `claude-code-only` | `claude-code (Foam MCP)` | `codex-sentry` | `codex-only` | `codex (Foam MCP)` |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
|    0 | 100 | 0 | 100 | 0 | 0 | 0 |
|    1 | 100 | 100 | 100 | 100 | 100 | 100 |
|    2 | 100 | 100 | 100 | 100 | 100 | 100 |
|    3 | 100 | 100 | 100 | 100 | 100 | 100 |
|    4 | 0 | 0 | 100 | 0 | 0 | 100 |
|    5 | 100 | 100 | 100 | 100 | 100 | 100 |
|    6 | 100 | 100 | 100 | 100 | 100 | 100 |
|    7 | 100 | 100 | 100 | 100 | 100 | 100 |
|    8 | 0 | 0 | 0 | 0 | 0 | 0 |
|    9 | 0 | 0 | 0 | 0 | 0 | 0 |
|   10 | 100 | 100 | 100 | 100 | 100 | 100 |
|   11 | 100 | 0 | 100 | 100 | 0 | 100 |
|   12 | 100 | 100 | 100 | 100 | 100 | 100 |
|   13 | 0 | 0 | 0 | 0 | 0 | 0 |
|   14 | 100 | 100 | 100 | 100 | 100 | 100 |
|   15 | 100 | 100 | 100 | 100 | 100 | 100 |
|   16 | 0 | 100 | 100 | 0 | 100 | 100 |
|   17 | - | - | - | - | - | - |
|   18 | 0 | 0 | 100 | 0 | 0 | 100 |
|   19 | 0 | 100 | 100 | 0 | 100 | 100 |
|   20 | 0 | 100 | 100 | 0 | 100 | 100 |
|   21 | 0 | 0 | 100 | 0 | 0 | 100 |
|   22 | 0 | 100 | 100 | 0 | 0 | 100 |

## Procedure

Same as [`04-04-2026`](../04-04-2026/README.md), with Claude Code and Codex in place of Cursor:

1. Each eval was initialised from the repository and commit SHA in its eval prompt, in an isolated git worktree.
2. Pre-existing eval directories were removed from the worktree.
3. Exactly one `claude -p` or `codex exec` run was launched per eval prompt, in parallel, with no
   root-cause information and no user interaction.
4. Reports were written to `./[experiment]/[index]/output.md`.
5. Outputs were scored afterward against the shared answer key using `scorer.ts`.

Conditions (each harness gets the same three setups):

- `*-only`: the harness with only the eval prompt and the repository worktree.
- `*-sentry`: same, with Sentry MCP permitted.
- `*-foam-mcp` (`* (Foam MCP)`): same, with Foam's `query-otel` tool.

## Scoring

```bash
cd 09-15-2026
npm install
OPENAI_API_KEY=... npx tsx scorer.ts [experiment]
```

`scorer.ts` is the April GPT-4o classifier (same incident, same precise root cause, same fix) with
its answer-key path pointed at `../04-04-2026/answers/`. `results.json` is a machine-readable dump
of every score plus the agent models.

## Folder structure

- `[experiment]/[index]/output.md` — agent report (mocked in this run)
- `[experiment]/[index]/score.txt` — score (100 / 0)
- `results.json` — all scores plus agent/judge models
- `scorer.ts`, `package.json` — copies of the April scorer
