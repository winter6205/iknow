# 0039. Ctrl+C waiting semantics: the boundary of uncancellable waits, and the feedback

Date: 2026-08-31

Status: accepted

## Context

The goal of Ctrl+C is not to make every underlying call physically abortable, but to give the caller a definite, explainable outcome. The ACI executor already distinguishes `cancel` from `block` by tool metadata: a `block` handler receives the tier signal instead of the caller signal, and the caller abort is normalized into `cancelled` only after the handler finishes winding down (`src/harness/aci/aci-executor.ts:306-310, 349-377`).

This existing `block` semantics must be distinguished from permission waiting. The `AskUser` interface currently carries only the tool, input, prompt, and an optional network flag — no signal (`src/harness/permission/types.ts:97-107`), and the permission executor awaits the boolean result of `askUser` directly (`src/harness/permission/permission-executor.ts:209-223`). That makes permission waiting an abort gap to fix, not an acceptable uncancellable wait.

`read_mcp_resource`'s "handler does not forward a signal" was an explicit M3 resolution, not an accidental omission: the handler parameter is named `_ctx`, and the comment justifies it with "the current manager.readResource(server, uri) contract has no signal parameter" (`src/harness/aci/tools/read-mcp-resource.ts:71-82`). That premise has expired: `McpManager.readResource` already takes an optional signal (`src/harness/mcp/manager.ts:237-241`), and the implementation merges the caller signal with the shutdown signal via `mergeAbort` before passing it to the MCP client (`src/harness/mcp/manager.ts:659-676`).

## Decision

### 1. Waits allowed to resist abort

Only the following two kinds of wait may temporarily be unreleasable by caller abort:

1. During the handler's own execution for an `interruptBehavior: "block"` tool. The contract of that tier is to let the handler wind down, not to route the caller signal into it.
2. Third-party MCP servers that have already received a request but do not honor cancellation. Whether a server obeys the cancel protocol is not something the host can guarantee.

Permission waiting (`AskUser`) belongs to neither class and must be releasable by abort. Outside these two classes, no underlying wait may default to "uncancellable".

### 2. Feedback when a wait cannot be released

After a caller abort, the caller must receive clear visible feedback that distinguishes at least these facts:

- the UI has stopped waiting, or this turn has closed as cancelled;
- the underlying operation is still winding down or running in the background, because its wait was not actually released;
- this is not the same as the underlying operation having stopped — it must not be dressed up as stopped, rolled back, or completed.

Feedback should ride the existing typed `cancelled`/stop-result and host-visible state channels; a silent return, an ordinary success result, or a vague "no response" must not stand in for these three facts. If the underlying work eventually completes, that completion must not overwrite the earlier notice that "the UI stopped waiting; the cancel did not physically abort it".

### 3. Keep the `block` tier's exclusion of caller signal

Maintain the existing M3 resolution: the `block` tier excludes the caller signal, and the handler continues using the tier timeout signal and finishes naturally. The reason is definitional — `block` means the handler completes its wind-down, rather than being force-interrupted on caller abort.

That does not mean caller abort is ignored. The outer layer must, after the handler finishes, normalize the result into the existing typed `execution_failed` whose `message` is `cancelled`; and per section 2, tell the caller "the UI stopped waiting, the underlying work is still winding down/running". No second cancellation state is introduced, and the call is never disguised as a success.

### 4. Reopen and overturn the M3 resolution for `read_mcp_resource`

This ADR explicitly **overturns** the part of the existing resolution that says "the `read_mcp_resource` handler does not forward a signal".

- **Original resolution**: the handler uses `_ctx` and calls `manager.readResource(parsed.server, parsed.uri)` without a signal; the stated reason was the comment's "the current manager.readResource(server, uri) contract has no signal parameter" (`src/harness/aci/tools/read-mcp-resource.ts:71-82`).
- **Why the reason expired**: the manager's public contract now supports `readResource(server, uri, opts?: { signal })` (`src/harness/mcp/manager.ts:237-241`); the implementation explicitly merges caller and shutdown signals with `mergeAbort(opts?.signal, slot.callAbort?.signal)` (`src/harness/mcp/manager.ts:659-676`). "No signal parameter" is no longer a code fact.
- **New resolution**: the `read_mcp_resource` handler must forward `ctx.signal` into `manager.readResource`'s options; the manager keeps merging it with the shutdown signal. The tool has always declared `interruptBehavior: "cancel"` (`src/harness/aci/tools/read-mcp-resource.ts:120`); forwarding the signal is what aligns it with its own metadata and `cancel` tier semantics.

This reopen covers signal forwarding only. It does not overturn the tool's other M3 constraints (resource content treated as untrusted data, typed error wrapping, executor output truncation).

## Consequences

### Positive

- Ctrl+C outcomes have a definite contract: the scope allowed to skip physical abort is limited, and permission waiting is no longer wrongly swept into the exception.
- `block`'s wind-down protection stays compatible with the existing typed `cancelled` result.
- `read_mcp_resource`'s declared metadata and its actual signal chain agree; when a third-party MCP ignores cancellation, the caller can still tell "UI stopped waiting" apart from "underlying work stopped".

### Negative / Trade-offs

- `block` handlers and non-cooperative third-party MCP requests may keep holding resources after the UI stops waiting, until they end naturally or the tier/shutdown machinery handles them.
- The host must surface both the cancellation close-out and the still-running underlying work, not a single success/failure literal.
- `AskUser`'s interface and each host implementation need a signal added separately; late approvals must then be treated as post-cancellation states.

## Reversibility

If, in the future, all `block` handlers and third-party MCP clients provide reliable cancellation, a new ADR may narrow the exception; until then, any narrowing must first present a real cancellation contract and visible-state evidence. `read_mcp_resource`'s signal forwarding can be reverted independently, but a revert must re-justify its `cancel` metadata and may not silently restore the old resolution.

## Evidence

- The finalized rulings on uncancellable waits, user feedback, and `block` tier semantics.
- `src/harness/aci/aci-executor.ts:306-310, 349-377`: `block` excludes the caller signal and normalizes to `cancelled` after wind-down.
- `src/harness/permission/types.ts:97-107`, `src/harness/permission/permission-executor.ts:209-223`: permission waiting currently has no signal parameter.
- `src/harness/mcp/manager.ts:237-241, 659-676`: `readResource` already supports and merges the caller signal.
