# 04-04-2026 Experiments

- Run date: `04-04-2026`
- Model used: `opus-4.6`

| Experiment        | 100% | 0%  | Accuracy |
| ----------------- | ---: | --: | -------: |
| `cursor-only`     |   12 |  10 |      55% |
| `cursor-sentry`   |    9 |  13 |      41% |
| `cursor-qo`       |   14 |   8 |      64% |
| `foam`            |   18 |   4 |      82% |

Per-eval results from `score.txt`:

| Eval | `cursor-only` | `cursor-sentry` | `cursor-qo` | `foam` |
| ---: | ------------: | --------------: | ----------: | -----: |
|    0 |             0 |             100 |           0 |      0 |
|    1 |           100 |             100 |         100 |    100 |
|    2 |           100 |               0 |           0 |    100 |
|    3 |           100 |             100 |         100 |    100 |
|    4 |             0 |               0 |         100 |    100 |
|    5 |           100 |             100 |         100 |    100 |
|    6 |           100 |               0 |         100 |    100 |
|    7 |           100 |               0 |         100 |    100 |
|    8 |             0 |               0 |           0 |    100 |
|    9 |             0 |               0 |           0 |      0 |
|   10 |             0 |             100 |           0 |    100 |
|   11 |             0 |             100 |           0 |    100 |
|   12 |           100 |             100 |         100 |      0 |
|   13 |             0 |               0 |           0 |      0 |
|   14 |           100 |             100 |         100 |    100 |
|   15 |           100 |             100 |         100 |    100 |
|   16 |           100 |               0 |           0 |    100 |
|   17 |             - |               - |           - |      - |
|   18 |             0 |               0 |         100 |    100 |
|   19 |             0 |               0 |         100 |    100 |
|   20 |           100 |               0 |         100 |    100 |
|   21 |             0 |               0 |         100 |    100 |
|   22 |           100 |               0 |         100 |    100 |

This directory contains four experimental conditions: `cursor-only`, `cursor-sentry`, `cursor-qo`, and `foam`.

At a high level, the procedure was as follows:

1. For each eval index, the experiment was initialized from a specific repository and commit SHA defined in the corresponding master prompt.
2. A dedicated git worktree was created for that eval so that each run was conducted in an isolated copy of the codebase.
3. Pre-existing eval directories were removed from the worktree to reduce the chance that agents could rely on precomputed artifacts instead of performing investigation.
4. The prepared worktree was briefly inspected before execution.
5. Exactly one agent was launched per eval prompt, with runs executed in parallel.
6. Each agent was given only the eval prompt for its assigned index, with no solution or root-cause information provided.
7. Each agent was constrained to investigate only within its assigned worktree.
8. The resulting report was written to `./[experiment]/[index]/output.md`.
9. Outputs were scored afterward against the answer key using `scorer.ts`, which writes `score.txt` next to each output.

The experimental conditions differed in the following way:

- `cursor-only`: baseline Cursor condition using only the eval prompt and the assigned repository worktree.
- `cursor-sentry`: same general setup, but the agent was explicitly permitted to use Sentry MCP during investigation.
- `cursor-qo`: same general setup, but the agent was given access to `query-otel`, a tool built by the Foam team.
- `foam`: an agent that root-causes bugs without user help or intervention.

High-level folder structure:

- `answers/`: answer-key RCAs used as the evaluation reference.
- `[experiment]/[index]/`: per-eval prompts, model outputs, and scores for each experimental condition.
- `scorer.ts`: scoring script used to compare outputs against the answer key and write `score.txt`.
