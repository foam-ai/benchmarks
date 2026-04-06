[Foam Trace ID: 2c56dacf611813d941db941987ba354e] ## TL;DR

The `SimpletonAgent` returned an empty string as its solution for runId `eb581e69-4677-42d6-b609-fa619edcd608`, most likely because the Vercel AI SDK's agent loop hit its `maxSteps` limit while the LLM was still making tool calls (never producing a final text response). The code has no validation or fallback for this case between `runDefault()` and `runSideEffects()`, so the empty string flowed through to the side-effects validation which correctly rejected it with `"Solution result is empty"`.

## What Broke and Why

The `solveIssue()` function in `mewtwo/src/services/issue-solver/index.ts` orchestrates issue resolution in two phases: first the agent solves the issue, then side effects are run:

```typescript
const solverResult = await runDefault(run);       // line ~36
await runSideEffects({                            // line 41
    run, customer, solverResult, ...
});
```

`runDefault()` (in `experiments/default.experiment.ts`) launches a `SimpletonAgent` (in `src/agents/base.ts`) which uses the **Vercel AI SDK** with the Anthropic provider (`anthropic.messages / claude-sonnet-4-20250514`). The AI SDK manages an iterative agent loop internally via `maxSteps`: each iteration the LLM either makes tool calls (loop continues) or produces a final text response (loop terminates).

**Telemetry shows the agent was actively investigating** the issue "undefined/auth/status is not a valid URL" and made at least **14 tool invocations** over ~6 minutes:
- 8 `queryOtel` (ClickHouse) calls — many returned empty/minimal results (2 chars)
- 4+ `grep` searches — all returned **0 matches** against the target repository
- 1+ `executeCommands` invocations — triggered a Docker image build (`base-agent-env-1000`)

The agent was still building a Docker image at `23:29:30` when telemetry logs hit the 200-entry truncation limit. The error fired at `23:34:36` — a ~5 minute gap of invisible activity. **No errors, exceptions, LLM failures, or Docker build failures** were logged during the visible portion of agent execution. All 200 log entries were `DEBUG` or `INFO` severity.

The most probable cause of the empty result: the AI SDK's agent loop exhausted its `maxSteps` limit while the LLM was still in tool-calling mode. When this happens, the SDK returns a result where `result.text` is an **empty string `""`** because the LLM never issued a final text-only response (`end_turn`). The agent was making many tool calls (many returning empty results, requiring escalation to different tools), and the Docker builds consumed wall-clock time without the agent reaching a conclusion.

This empty string flowed through `runDefault()` → the Braintrust `traced()` wrapper → back to `solveIssue()` as `solverResult`, and was passed directly to `runSideEffects()` with **zero intermediate validation**. The validation in `runSideEffects` at `side-effects/index.ts:30-31` correctly detected the problem:

```typescript
if (!result || result.trim().length === 0) {
    const error = new Error(
        `Solution result is empty for runId: ${runId}. Cannot mark as completed with empty solution.`,
    );
```

**The missing safeguard is in the agent/experiment layer**: there is no check of the AI SDK's `finishReason` to detect premature termination, no fallback to assemble partial results from the tool outputs gathered so far, and no retry logic to give the agent additional steps.

**Alternative hypothesis considered and eliminated:** An error during the invisible 5-minute window (e.g., Docker build failure, LLM API timeout) could have been caught internally, causing an empty return. This was ruled out because: (a) no error-level logs exist anywhere in the 200 visible entries, (b) no retry or error-recovery patterns are visible, (c) all tool calls completed successfully, and (d) the pattern of many tool calls over a long duration without reaching a conclusion is characteristic of `maxSteps` exhaustion, not an error scenario.

## Fix

**Add `finishReason` and empty-result validation in `runDefault()` / the `SimpletonAgent` layer**, before returning the result to `solveIssue()`:

1. **Check `finishReason`**: After the AI SDK's `generateText`/`streamText` completes, inspect `result.finishReason`. If it is `'length'` (token limit) or if the last step's `finishReason` is `'tool-calls'` (maxSteps exhausted mid-tool-use), the agent did not complete normally.

2. **Validate `result.text`**: If `result.text` is empty or whitespace-only after the agent loop completes, do not return it as-is.

3. **Fallback/recovery**: When the agent terminates without a final text response:
   - **Option A (recommended)**: Assemble a fallback summary from the tool results collected during the agent's execution (the queryOtel results, grep results, etc. are available in `result.steps`) and return that as a partial/inconclusive solution.
   - **Option B**: Retry with a higher `maxSteps` or with a prompt instructing the LLM to summarize its findings immediately.
   - **Option C**: Return a structured "inconclusive" result that `runSideEffects` can handle gracefully (e.g., marking the run as "incomplete" rather than "completed").

```typescript
// In SimpletonAgent or runDefault:
const result = await generateText({ model, messages, tools, maxSteps });

if (!result.text || result.text.trim().length === 0) {
    const lastStep = result.steps[result.steps.length - 1];
    if (lastStep?.finishReason === 'tool-calls' || result.finishReason === 'length') {
        // Agent hit maxSteps without concluding — assemble partial results
        const partialSummary = assemblePartialResults(result.steps);
        return partialSummary || 'Agent could not complete analysis within step limit.';
    }
    throw new Error(`Agent returned empty result (finishReason: ${result.finishReason})`);
}
return result.text;
```

**Why this fix breaks the causal chain:** The empty string from `maxSteps` exhaustion is caught at the agent layer (where the AI SDK result metadata like `finishReason` and `steps` are still available), preventing it from silently flowing through to `runSideEffects`. The fix either produces a meaningful partial result or surfaces a clear, actionable error — rather than letting an empty string propagate through two function boundaries before being caught by a generic validation check that lacks context about *why* the result was empty.

---
