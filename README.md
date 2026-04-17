# Benchmarks

RCA (Root Cause Analysis) evaluation benchmarks for the Foam agent. Each eval replays a real-world incident and scores the agent's root cause analysis against a human-written answer key using a GPT-4o classifier.

## Results Overview

```
Accuracy (%)     0    10    20    30    40    50    60    70    80    90   100
                 ├─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┤

04-04-2026
  foam-none      ████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  40.9%  (9/22)
  cursor-sentry  ████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  40.9%  (9/22)
  cursor-only    ███████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░  54.5%  (12/22)
  cursor-qo      ████████████████████████████████░░░░░░░░░░░░░░░░░░░  63.6%  (14/22)
  foam           ██████████████████████████████████████░░░░░░░░░░░░░░  77.2%  (17/22)

04-12-2026
  foam           ███████████████████████████████████████████░░░░░░░░░  86.4%  (19/22)
```

## Timeline

| Date | Best Agent | Accuracy | Evals |
|------|-----------|----------|-------|
| **04-12-2026** | foam (`repr-qo-b-rlm`) | **86.4%** (19/22) | 22 |
| 04-04-2026 | foam (production) | 77.2% (17/22) | 22 |

## Benchmark Runs

### [04-12-2026](./04-12-2026/)

Latest run with the `repr-qo-b-rlm` experiment configuration.

| Experiment | Score | Accuracy |
|------------|-------|----------|
| **foam** | **19/22** | **86.4%** |

### [04-04-2026](./04-04-2026/)

Initial comprehensive benchmark comparing 5 agent configurations.

| Experiment | Score | Accuracy |
|------------|-------|----------|
| foam (production) | 17/22 | 77.2% |
| cursor-qo | 14/22 | 63.6% |
| cursor-only | 12/22 | 54.5% |
| cursor-sentry | 9/22 | 40.9% |
| foam-none | 9/22 | 40.9% |

## Eval Suite

22 real-world production incidents covering: empty solutions, tool ordering bugs, Redis OOM, Sentry integration errors, ClickHouse query failures, Vertex AI fallback issues, worker timeouts, git worktree exhaustion, Azure API misconfigurations, and more.

Answer keys and scoring details are in each date's directory.

## Scoring

Outputs are scored by a GPT-4o classifier (`scorer.ts`) that checks:
1. Same incident
2. Same precise root cause
3. Would lead an engineer to the same fix

```bash
cd <date-dir>
OPENAI_API_KEY=... npx tsx scorer.ts [experiment]
```
