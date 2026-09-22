## TL;DR

The Docker image for `mewtwo` no longer copies the `vendor/drain3` Python package, so Pyodide cannot load `foam_wrapper` at runtime.

## What Broke and Why

**Observed error:** `ModuleNotFoundError: No module named 'foam_wrapper' (drain3-pyodide.service.ts)`

Sentry MCP (`get_sentry_resource` / `search_issue_events`) was used to pull the issue, its tags and the events around the error timestamp before reading the code.

### Causal Chain

**1.** The error is a missing module, which points at the image build.

**2.** The Dockerfile was recently changed to a multi-stage build.

## Fix

- Add a `COPY vendor/ ./vendor/` step to the runtime stage.

---

## Metrics

**Performance:**
- Total latency: 494 seconds
- Token usage: 166,003 + 14,146 = 180,149 tokens

**Tool Usage:**
- Top 3 most-used tools: read_file, get_sentry_resource, shell
- Top 3 most USEFUL tools: get_sentry_resource (input: the Sentry issue, tags and breadcrumbs) shell (input: rg/git log over the failing service) read_file (input: the throwing function and its callers)
