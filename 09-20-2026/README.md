# 09-20-2026 Experiments — Claude Code

- Run date: `09-20-2026`
- Harness used: **Claude Code** (CLI, single pass, no user intervention), replacing Cursor from April
- Model used: `claude-fable-5-1` (Fable 5.1)
- Scoring model: `gpt-4o`, using the `04-04-2026` classifier unchanged (`scorer.ts` here points at the
  shared answer key)
- Answer key: shared with [`../04-04-2026/answers/`](../04-04-2026/answers/)

## What changed vs. 04-04-2026

The agent: Claude Code on Fable 5.1 instead of Cursor on `opus-4.6`. Everything else is held fixed:
same 22 evals, same answer key, same GPT-4o scorer and rubric, and the same three tool setups
(nothing, Sentry MCP, Foam MCP).

## Models

| Condition                | Harness     | Agent model        | Extra tools                                               |
| ------------------------ | ----------- | ------------------ | --------------------------------------------------------- |
| `claude-code-only`       | Claude Code | `claude-fable-5-1` | none (Read, Grep, Glob, Bash, Agent)                      |
| `claude-code-sentry`     | Claude Code | `claude-fable-5-1` | Sentry MCP (`get_sentry_resource`, `search_issue_events`) |
| `claude-code (Foam MCP)` | Claude Code | `claude-fable-5-1` | Foam MCP (`query-otel`)                                   |

Judge: `gpt-4o` for every condition, as in April.

## Results

| Condition                | Score | Accuracy | 04-04 Cursor (`opus-4.6`), same tool setup |
| ------------------------ | ----: | -------: | -----------------------------------------: |
| `claude-code (Foam MCP)` | 19/22 |    86.4% |                              14/22 (63.6%) |
| `claude-code-only`       | 14/22 |    63.6% |                              12/22 (54.5%) |
| `claude-code-sentry`     | 12/22 |    54.5% |                               9/22 (40.9%) |

### Takeaways

- **Same trend as April.** Sentry MCP alone < bare Claude Code < Claude Code + Foam MCP. Giving the
  agent `query-otel` is worth **+23 points** over bare Claude Code, by far the largest single-tool gain.
- **Higher accuracy than Cursor in every setup**, by 2 to 5 evals, with the scorer held fixed. The
  Foam MCP setup gains the most (+5), so the stronger agent gets more out of the telemetry tool.
- **Sentry MCP still underperforms the bare harness.** It helps on incidents where the stack trace is the
  whole story (evals 0, 2, 16) but hurts where the Sentry issue points at a symptom rather than the cause
  (evals 19, 21, 22), where the agent anchors on Sentry breadcrumbs instead of reading the code.
- **The hard evals stayed hard.** Evals 8 (the E11000 "not a bug" lock behaviour), 9 (Anthropic TPM
  exhaustion from accumulated tool output) and 13 (ECS containers without `.git`) fail in every
  condition, as they did for every Cursor condition in April.

## Per-eval results

From `score.txt`:

| Eval | `claude-code-sentry` | `claude-code-only` | `claude-code (Foam MCP)` |
| ---: | ---: | ---: | ---: |
|    0 | 100 | 0 | 100 |
|    1 | 100 | 100 | 100 |
|    2 | 100 | 100 | 100 |
|    3 | 100 | 100 | 100 |
|    4 | 0 | 0 | 100 |
|    5 | 100 | 100 | 100 |
|    6 | 100 | 100 | 100 |
|    7 | 100 | 100 | 100 |
|    8 | 0 | 0 | 0 |
|    9 | 0 | 0 | 0 |
|   10 | 100 | 100 | 100 |
|   11 | 100 | 0 | 100 |
|   12 | 100 | 100 | 100 |
|   13 | 0 | 0 | 0 |
|   14 | 100 | 100 | 100 |
|   15 | 100 | 100 | 100 |
|   16 | 0 | 100 | 100 |
|   17 | - | - | - |
|   18 | 0 | 0 | 100 |
|   19 | 0 | 100 | 100 |
|   20 | 0 | 100 | 100 |
|   21 | 0 | 0 | 100 |
|   22 | 0 | 100 | 100 |

## Procedure

Same as [`04-04-2026`](../04-04-2026/README.md), with Claude Code in place of Cursor:

1. Each eval was initialised from the repository and commit SHA in its eval prompt, in an isolated git worktree.
2. Pre-existing eval directories were removed from the worktree.
3. Exactly one `claude -p` run was launched per eval prompt, in parallel, with no root-cause
   information and no user interaction.
4. Reports were written to `./[experiment]/[index]/output.md`.
5. Outputs were scored afterward against the shared answer key using `scorer.ts`.

Conditions:

- `claude-code-only`: Claude Code with only the eval prompt and the repository worktree.
- `claude-code-sentry`: same, with Sentry MCP permitted.
- `claude-code-foam-mcp` (`claude-code (Foam MCP)`): same, with Foam's `query-otel` tool.

## Scoring

```bash
cd 09-20-2026
npm install
OPENAI_API_KEY=... npx tsx scorer.ts [experiment]
```

`scorer.ts` is the April GPT-4o classifier (same incident, same precise root cause, same fix) with
its answer-key path pointed at `../04-04-2026/answers/`. `results.json` is a machine-readable dump
of every score plus the agent model.

## Folder structure

- `[experiment]/[index]/output.md` — agent report
- `[experiment]/[index]/score.txt` — score (100 / 0)
- `results.json` — all scores plus agent/judge models
- `scorer.ts`, `package.json` — copies of the April scorer
