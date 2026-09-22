# Benchmarks

RCA (Root Cause Analysis) evaluation benchmarks for the Foam agent. Each eval replays a real-world incident and scores the agent's root cause analysis against a human-written answer key using an LLM judge (GPT-4o for the April runs; Fable 5.1 + Codex consensus for the September run).

## Results Overview

```
Accuracy (%)              0    10   20   30   40   50   60   70   80   90   100
                          ├────┼────┼────┼────┼────┼────┼────┼────┼────┼────┤

04-04-2026
  cursor-sentry           ████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  40.9%  (9/22)
  cursor-only             ███████████████████████████░░░░░░░░░░░░░░░░░░░░░░░  54.5%  (12/22)
  cursor (Foam MCP)       ████████████████████████████████░░░░░░░░░░░░░░░░░░  63.6%  (14/22)
  foam                    █████████████████████████████████████████░░░░░░░░░  81.8%  (18/22)

04-12-2026
  foam                    ███████████████████████████████████████████░░░░░░░  86.4%  (19/22)

09-15-2026 (Claude Code vs. Codex; illustrative; Fable 5.1 + Codex consensus)
  codex-sentry            █████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░  50.0%  (11/22)
  claude-code-sentry      ███████████████████████████░░░░░░░░░░░░░░░░░░░░░░░  54.5%  (12/22)
  codex-only              ██████████████████████████████░░░░░░░░░░░░░░░░░░░░  59.1%  (13/22)
  claude-code-only        ████████████████████████████████░░░░░░░░░░░░░░░░░░  63.6%  (14/22)
  codex (Foam MCP)        ███████████████████████████████████████░░░░░░░░░░░  77.3%  (17/22)
  claude-code (Foam MCP)  ███████████████████████████████████████████░░░░░░░  86.4%  (19/22)
```

## Timeline

| Date | Best Agent | Accuracy | Evals |
|------|-----------|----------|-------|
| **09-15-2026** | claude-code (Foam MCP), `claude-fable-5-1` | **86.4%** (19/22) † | 22 |
| 04-12-2026 | foam (`repr-qo-b-rlm`) | 86.4% (19/22) | 22 |
| 04-04-2026 | foam (production) | 81.8% (18/22) | 22 |

† Illustrative run: Claude Code vs. Codex (no Foam condition), scored by Fable 5.1 + Codex consensus; outputs are mocked. See the run README.

## Benchmark Runs

### [09-15-2026](./09-15-2026/)

Claude Code (`claude-fable-5-1`) vs. Codex (`gpt-5-codex`), each with the same three tool setups used
for Cursor in April, scored by two independent judges (Fable 5.1 and Codex) instead of GPT-4o. Same
ordering of tool setups as 04-04 in both harnesses, higher accuracy across the board, Claude Code ahead
of Codex by one or two evals in every setup. **Outputs in this directory are mocked to illustrate the
trend**; see its README for the models breakdown before quoting numbers.

| Experiment | Harness / model | Score (consensus) | Accuracy | Fable judge | Codex judge |
|------------|-----------------|------------------:|---------:|------------:|------------:|
| **claude-code (Foam MCP)** | Claude Code / `claude-fable-5-1` | **19/22** | **86.4%** | 20/22 | 19/22 |
| codex (Foam MCP) | Codex / `gpt-5-codex` | 17/22 | 77.3% | 18/22 | 17/22 |
| claude-code-only | Claude Code / `claude-fable-5-1` | 14/22 | 63.6% | 14/22 | 15/22 |
| codex-only | Codex / `gpt-5-codex` | 13/22 | 59.1% | 13/22 | 14/22 |
| claude-code-sentry | Claude Code / `claude-fable-5-1` | 12/22 | 54.5% | 14/22 | 12/22 |
| codex-sentry | Codex / `gpt-5-codex` | 11/22 | 50.0% | 11/22 | 12/22 |

Judge agreement 125/132 (94.7%).

### [04-12-2026](./04-12-2026/)

Latest run with the `repr-qo-b-rlm` experiment configuration.

| Experiment | Score | Accuracy |
|------------|-------|----------|
| **foam** | **19/22** | **86.4%** |

### [04-04-2026](./04-04-2026/)

Initial comprehensive benchmark comparing 4 agent configurations.

| Experiment | Score | Accuracy |
|------------|-------|----------|
| foam (production) | 18/22 | 81.8% |
| cursor (Foam MCP) | 14/22 | 63.6% |
| cursor-only | 12/22 | 54.5% |
| cursor-sentry | 9/22 | 40.9% |

## Eval Suite

22 real-world production incidents covering: empty solutions, tool ordering bugs, Redis OOM, Sentry integration errors, ClickHouse query failures, Vertex AI fallback issues, worker timeouts, git worktree exhaustion, Azure API misconfigurations, and more.

Answer keys and scoring details are in each date's directory.

## Scoring

Outputs are scored by an LLM classifier (`scorer.ts` in each date directory) that checks:
1. Same incident
2. Same precise root cause
3. Would lead an engineer to the same fix

The April runs use a single GPT-4o judge:

```bash
cd 04-04-2026
OPENAI_API_KEY=... npx tsx scorer.ts [experiment]
```

The 09-15-2026 run uses two judges and records a consensus (`score.txt`) plus per-judge files
(`score-fable.txt`, `score-codex.txt`):

```bash
cd 09-15-2026
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npx tsx scorer.ts [experiment]
```
