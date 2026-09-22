# Benchmarks

RCA (Root Cause Analysis) evaluation benchmarks for the Foam agent. Each eval replays a real-world incident and scores the agent's root cause analysis against a human-written answer key using a GPT-4o classifier.

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

09-15-2026 (Claude Code vs. Codex; illustrative)
  codex-sentry            █████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░  50.0%  (11/22)
  claude-code-sentry      ███████████████████████████░░░░░░░░░░░░░░░░░░░░░░░  54.5%  (12/22)
  codex-only              ██████████████████████████████░░░░░░░░░░░░░░░░░░░░  59.1%  (13/22)
  claude-code-only        ████████████████████████████████░░░░░░░░░░░░░░░░░░  63.6%  (14/22)
  codex (Foam MCP)        █████████████████████████████████████████░░░░░░░░░  81.8%  (18/22)
  claude-code (Foam MCP)  ███████████████████████████████████████████░░░░░░░  86.4%  (19/22)
```

## Timeline

| Date | Best Agent | Accuracy | Evals |
|------|-----------|----------|-------|
| **09-15-2026** | claude-code (Foam MCP), `opus-4.6` | **86.4%** (19/22) † | 22 |
| 04-12-2026 | foam (`repr-qo-b-rlm`) | 86.4% (19/22) | 22 |
| 04-04-2026 | foam (production) | 81.8% (18/22) | 22 |

† Illustrative run: Claude Code vs. Codex, same GPT-4o scorer as April; outputs are mocked. See the run README.

## Benchmark Runs

### [09-15-2026](./09-15-2026/)

Claude Code (`opus-4.6`, the April model) and Codex (`gpt-5-codex`) in place of Cursor, each with the
same three tool setups used in April, scored with the same GPT-4o classifier. Only the harness changes.
Same ordering of tool setups as 04-04 in both harnesses, higher accuracy across the board, Claude Code
ahead of Codex by one eval in every setup. **Outputs in this directory are mocked to illustrate the
trend**; see its README before quoting numbers.

| Experiment | Harness / model | Score | Accuracy |
|------------|-----------------|------:|---------:|
| **claude-code (Foam MCP)** | Claude Code / `opus-4.6` | **19/22** | **86.4%** |
| codex (Foam MCP) | Codex / `gpt-5-codex` | 18/22 | 81.8% |
| claude-code-only | Claude Code / `opus-4.6` | 14/22 | 63.6% |
| codex-only | Codex / `gpt-5-codex` | 13/22 | 59.1% |
| claude-code-sentry | Claude Code / `opus-4.6` | 12/22 | 54.5% |
| codex-sentry | Codex / `gpt-5-codex` | 11/22 | 50.0% |

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

Outputs are scored by a GPT-4o classifier (`scorer.ts` in each date directory) that checks:
1. Same incident
2. Same precise root cause
3. Would lead an engineer to the same fix

```bash
cd <date-dir>
OPENAI_API_KEY=... npx tsx scorer.ts [experiment]
```
