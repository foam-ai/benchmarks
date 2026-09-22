[Foam Trace ID: 05255a35e22d0a5bc0b388feb51cf1cc] ## TL;DR

`queryOtel` now returns structured JSON where the AI SDK expects text; the tool output change and the SDK's string assumption together produce the `.match()` crash.

## What Broke and Why

**Observed error:** `TypeError: text2.match is not a function (ai/dist/index.mjs)`

Foam correlated the failing trace with the deployed commit and walked the call chain from the stacktrace to the originating change.

### Causal Chain

**1.** Tool output became an object after a recent change.

**2.** SDK calls `.match()` on tool results.

## Fix

- Stringify the tool result before returning it.


---
