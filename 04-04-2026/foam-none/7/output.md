[Foam Trace ID: 6180130d7a718a789b867d00dab7c876] ## TL;DR

The exception polling worker crashes with a `PythonError` during Drain3 state loading because one or more of the 16 `FoamIssue` clusters stored in MongoDB contain `null` values in their `logTemplateTokens` array. These nulls are faithfully serialized to Python `None` by `toPythonLiteral()`, then passed into drain3's `add_seq_to_prefix_tree()` which calls `has_numbers(None)`, raising `TypeError: 'NoneType' object is not iterable`. The fix is to filter out null tokens during serialization in `loadFoamIssueState` and add defensive validation in `foam_wrapper.py`'s `load_state`.

## What Broke and Why

The error originates in the exception polling worker processing job `poll-674e5380f251f603c5ef1847-webapp-browser-1772418811687`. The worker fetches 1 new exception span from ClickHouse, then attempts to load existing Drain3 cluster state from MongoDB before processing it. The crash occurs during **state loading**, not during log processing — confirmed by telemetry showing the last successful log at `drain3-pyodide.service.js:323`:

```
Loading state for 674e5380f251f603c5ef1847:webapp-browser with 16 clusters and 0 masks
```

followed 22ms later by:

```
Batch processing failed for 674e5380f251f603c5ef1847:webapp-browser
```

with no intervening "State loaded" success log (which would appear at TS line 514).

**The causal chain:**

1. **MongoDB stores null tokens**: The `FoamIssue` collection contains 16 clusters for this customer:service pair. At least one cluster has `null` elements in its `logTemplateTokens` array (e.g., `["Error", null, "occurred"]`). MongoDB's `[String]` schema type does not prevent null array elements.

2. **`toPythonLiteral()` converts null to Python None**: In `drain3-pyodide.service.ts`, the serialization function:
```typescript
function toPythonLiteral(value: unknown): string {
    return JSON.stringify(value)
        .replace(/\bnull\b/g, 'None')
        .replace(/\btrue\b/g, 'True')
        .replace(/\bfalse\b/g, 'False');
}
```
faithfully converts JS `null` → JSON `null` → Python `None`. The generated Python code embeds `None` directly in the cluster literal: `[{"cluster_id": 1, "log_template_tokens": ["Error", None, "occurred"], "size": 5}]`.

3. **`loadFoamIssueState()` passes this to Pyodide**: The function at TS line ~13459 constructs and evaluates Python code via `pyodideInstance.runPythonAsync()`:
```python
clusters = ${toPythonLiteral(snakeClusters)}
load_state(customer_id, service_id, clusters, config, masks)
```

4. **`foam_wrapper.py`'s `load_state()` has no validation**:
```python
for cluster_data in clusters:
    tokens = cluster_data["log_template_tokens"]  # contains None
    cluster = LogCluster(tokens, cluster_id)       # tuple(tokens) preserves None
    miner.drain.add_seq_to_prefix_tree(miner.drain.root_node, cluster)
```
`LogCluster.__init__` does `self.log_template_tokens = tuple(log_template_tokens)` with no type checking.

5. **`add_seq_to_prefix_tree()` crashes on None token**: When iterating tokens in the prefix tree insertion:
```python
for token in cluster.log_template_tokens:
    if token not in cur_node.key_to_child_node:
        if self.parametrize_numeric_tokens and self.has_numbers(token):  # token = None
```
`has_numbers` is:
```python
@staticmethod
def has_numbers(s: Iterable[str]) -> bool:
    return any(char.isdigit() for char in s)  # TypeError: 'NoneType' object is not iterable
```

6. **Error propagates up**: The `PythonError` (wrapping the `TypeError`) propagates from Pyodide → `foam-issue-batch-processor.service.ts:286` (caught, logged, returns `{success: false}`) → `exception-polling.worker.ts:327` which checks `if (!result.success)` and throws `new Error("Failed to process batch for ...")`.

**Alternative hypothesis considered and eliminated**: A Python 3.13 incompatibility was considered since the Pyodide runtime uses Python 3.13 (`/lib/python313.zip/`). However, the `TypeError` from iterating over `None` is version-independent — this error would occur on any Python version. The truncated traceback format (`...<9 lines>...`) is a Python 3.13 feature but is not the cause of the error.

**Secondary bug noted**: The `toPythonLiteral()` regex also corrupts string *content* — e.g., a token string `"null pointer"` becomes `"None pointer"` because `\b` word-boundary matches inside JSON string values. This is a data corruption bug but does not cause the crash (it produces incorrect strings, not `None` values). Additionally, the masks line `masks = [] if [] else None` always evaluates to `None` due to `[]` being falsy in Python, but `load_state` handles `masks=None` gracefully.

## Fix

**Primary fix — validate tokens in `foam_wrapper.py`'s `load_state()`**:

```python
def load_state(self, customer_id, service_id, clusters, config=None, masks=None):
    from drain3.drain import LogCluster
    key = self._make_key(customer_id, service_id)
    miner = self.get_or_create_miner(customer_id, service_id, config, masks)

    for cluster_data in clusters:
        cluster_id = cluster_data["cluster_id"]
        tokens = cluster_data["log_template_tokens"]
        size = cluster_data["size"]

        # Filter out None/null tokens that may come from MongoDB
        tokens = [t if t is not None else "<*>" for t in tokens]

        cluster = LogCluster(tokens, cluster_id)
        cluster.size = size
        # ... rest unchanged
```

**Secondary fix — filter nulls during serialization in `loadFoamIssueState()`** (defense-in-depth):

```typescript
const snakeClusters = clusters.map((c) => {
    const snake = toSnakeCase(c as unknown as Record<string, unknown>);
    // Filter null tokens before serialization
    if (Array.isArray(snake.log_template_tokens)) {
        snake.log_template_tokens = snake.log_template_tokens.map(
            (t: unknown) => t ?? '<*>'
        );
    }
    return snake;
});
```

**Why this fixes the root cause**: The `TypeError` occurs because `None` tokens reach `has_numbers()`. By replacing `None` tokens with `"<*>"` (the Drain3 wildcard token), the prefix tree insertion proceeds correctly — wildcards are a semantically appropriate replacement since a null token represents an unknown/variable part of the log template. This fix breaks the causal chain at step 4 (token validation), preventing `None` from ever reaching `add_seq_to_prefix_tree`. The error cannot recur through another path because all cluster data flows through `load_state` before reaching drain3 internals.

**Additionally recommended**: Add a MongoDB data migration to fix existing null tokens in the `FoamIssue` collection: `db.foamissues.updateMany({"logTemplateTokens": null}, [{$set: {"logTemplateTokens": {$map: {input: "$logTemplateTokens", as: "t", in: {$ifNull: ["$$t", "<*>"]}}}}}])`.

---
