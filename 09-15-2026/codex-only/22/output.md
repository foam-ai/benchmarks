## TL;DR

`queryOtel` now returns structured JSON where the AI SDK expects text; the tool output change and the SDK's string assumption together produce the `.match()` crash.

## What Broke and Why

**Observed error:** `TypeError: text2.match is not a function (ai/dist/index.mjs)`

### Causal Chain

**1.** Tool output became an object after a recent change.

**2.** SDK calls `.match()` on tool results.

## Fix

- Stringify the tool result before returning it.

---

## Metrics

**Performance:**
- Total latency: 445 seconds
- Token usage: 278,411 + 14,901 = 293,312 tokens

**Tool Usage:**
- Top 3 most-used tools: shell, apply_patch, read_file
- Top 3 most USEFUL tools: shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers) update_plan (input: tracking the investigation steps)
