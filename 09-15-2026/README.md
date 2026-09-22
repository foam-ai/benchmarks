# 09-15-2026 Experiments — Claude Code vs. Codex

> **Illustrative run.** The `output.md` files and scores in this directory are mocked to show the
> shape of the results and the trend the team observed. They are not verbatim agent transcripts.
> Treat the numbers as directional, not as a measured result.

- Run date: `09-15-2026`
- Harnesses under test: **Claude Code** (Anthropic CLI) and **Codex** (OpenAI CLI), both single-pass,
  no user intervention. These replace the Cursor conditions used in [`04-04-2026`](../04-04-2026/README.md).
- Judges: `claude-fable-5-1` (Fable 5.1) and `gpt-5-codex` (Codex), run independently
- Answer key: shared with [`../04-04-2026/answers/`](../04-04-2026/answers/)

## Models breakdown

### Agents

| Condition                | Harness     | Agent model        | Extra tools                                               |
| ------------------------ | ----------- | ------------------ | --------------------------------------------------------- |
| `claude-code-only`       | Claude Code | `claude-fable-5-1` | none (Read, Grep, Glob, Bash, Agent)                      |
| `claude-code-sentry`     | Claude Code | `claude-fable-5-1` | Sentry MCP (`get_sentry_resource`, `search_issue_events`) |
| `claude-code (Foam MCP)` | Claude Code | `claude-fable-5-1` | Foam MCP (`query-otel`)                                   |
| `codex-only`             | Codex       | `gpt-5-codex`      | none (shell, read_file, apply_patch, update_plan)         |
| `codex-sentry`           | Codex       | `gpt-5-codex`      | Sentry MCP (`get_sentry_resource`, `search_issue_events`) |
| `codex (Foam MCP)`       | Codex       | `gpt-5-codex`      | Foam MCP (`query-otel`)                                   |

### Judges

| Judge     | Model              | Provider  |
| --------- | ------------------ | --------- |
| Fable 5.1 | `claude-fable-5-1` | Anthropic |
| Codex     | `gpt-5-codex`      | OpenAI    |

Each harness runs on its vendor's own model, and each vendor's model also serves as one of the two
judges. To keep either judge from favouring its own harness, an eval counts as correct only when
**both** judges answer "Yes" (consensus). Per-judge verdicts are stored next to every output so the
self-preference effect can be inspected directly (see the Fable-alone / Codex-alone columns below).

## Results

| Condition                | Consensus | Accuracy | Fable 5.1 alone | Codex alone   | 04-04 Cursor equivalent (GPT-4o) |
| ------------------------ | --------: | -------: | --------------: | ------------: | -------------------------------: |
| `claude-code (Foam MCP)` |     19/22 |    86.4% |   20/22 (90.9%) | 19/22 (86.4%) |                    14/22 (63.6%) |
| `codex (Foam MCP)`       |     17/22 |    77.3% |   18/22 (81.8%) | 17/22 (77.3%) |                    14/22 (63.6%) |
| `claude-code-only`       |     14/22 |    63.6% |   14/22 (63.6%) | 15/22 (68.2%) |                    12/22 (54.5%) |
| `codex-only`             |     13/22 |    59.1% |   13/22 (59.1%) | 14/22 (63.6%) |                    12/22 (54.5%) |
| `claude-code-sentry`     |     12/22 |    54.5% |   14/22 (63.6%) | 12/22 (54.5%) |                     9/22 (40.9%) |
| `codex-sentry`           |     11/22 |    50.0% |   11/22 (50.0%) | 12/22 (54.5%) |                     9/22 (40.9%) |

Judge agreement: **125/132 (94.7%)**. The 7 splits are marked † below and all resolve to 0 under consensus.

### Takeaways

- **Same trend as April, for both harnesses.** Sentry MCP alone ≤ bare harness < harness + Foam MCP.
  Giving the agent `query-otel` is worth **+23 points** for Claude Code and **+18 points** for Codex
  under consensus, by far the largest single-tool gain in either harness.
- **Claude Code on Fable 5.1 edges out Codex on gpt-5-codex in every tool setup**, by one to two evals.
  The gap is widest with Foam MCP (19 vs 17), where Claude Code turned `query-otel` results into the
  right causal chain on evals 0 and 18 and Codex did not.
- **Under the Fable judge, bare Claude Code and Claude Code + Sentry tie (14/22).** Sentry context helps
  on incidents where the stack trace is the whole story (evals 0, 2, 16) but hurts where the Sentry issue
  points at a symptom rather than the cause (evals 19, 21, 22), where both harnesses anchor on Sentry
  breadcrumbs instead of reading the code. Codex-the-judge is stricter on the Sentry outputs.
- **Self-preference is small but visible.** Fable scores Claude Code one eval higher than consensus in
  each setup; Codex scores its own harness one eval higher in each setup. Consensus removes both.
- **Higher accuracy than April across the board.** Part of this is the harness/model change (Claude Code
  and Codex vs. Cursor on opus-4.6); part is judge behaviour. Both new judges accept an RCA that names the
  right underlying condition at a different level of abstraction, which GPT-4o sometimes marked as
  "different root cause".
- **The hard evals stayed hard.** Evals 8 (the E11000 "not a bug" lock behaviour), 9 (Anthropic TPM
  exhaustion from accumulated tool output) and 13 (ECS containers without `.git`) fail in every condition;
  eval 0 (the `solverResult`/`result` property mismatch) is only solved by `claude-code-sentry` and
  `claude-code (Foam MCP)`.

## Per-eval results

Consensus `score.txt`; † = judges split (see `score-fable.txt` / `score-codex.txt`).

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
|   11 | 100 | 0 † | 100 | 100 | 0 | 100 |
|   12 | 100 | 100 | 100 | 100 | 100 | 100 |
|   13 | 0 | 0 | 0 † | 0 | 0 | 0 |
|   14 | 100 | 100 | 100 | 100 | 100 | 100 |
|   15 | 100 | 100 | 100 | 100 | 100 | 100 |
|   16 | 0 † | 100 | 100 | 0 † | 100 | 100 |
|   17 | - | - | - | - | - | - |
|   18 | 0 | 0 | 100 | 0 | 0 | 0 † |
|   19 | 0 | 100 | 100 | 0 | 100 | 100 |
|   20 | 0 † | 100 | 100 | 0 | 100 | 100 |
|   21 | 0 | 0 | 100 | 0 | 0 | 100 |
|   22 | 0 | 100 | 100 | 0 | 0 † | 100 |

### Judge splits

| Cell                          | Fable | Codex | Why they disagreed (summary)                                                        |
| ----------------------------- | ----: | ----: | ----------------------------------------------------------------------------------- |
| `claude-code-sentry` / 16     |   100 |     0 | Output names the deployment-URL path but also blames the API version.               |
| `claude-code-sentry` / 20     |   100 |     0 | Output finds the stale worktree registry entry but adds a concurrency hypothesis.   |
| `claude-code-only` / 11       |     0 |   100 | Output says the job was mis-enqueued but frames a schema change as a co-cause.      |
| `claude-code (Foam MCP)` / 13 |   100 |     0 | Output finds the missing `.git` but under-specifies the swallowed pre-flight error. |
| `codex-sentry` / 16           |     0 |   100 | Same hedge as the Claude Code Sentry output; the judges flip.                       |
| `codex-only` / 22             |     0 |   100 | Output identifies the non-string tool result but not the PR #401 schema change.     |
| `codex (Foam MCP)` / 18       |   100 |     0 | Output blames the join but does not isolate `DATE(Timestamp)` as the cross-product. |

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
