# 0005. Executor hardening (unified stop signal + JSON-compatibility whitelist)

Date: 2026-08-04
Status: accepted

## Context

Block B of the GH issue (Q6/Q7/Q8, executor chassis hardening). The executor is the master gate for Foundation tool execution (every tool result must pass through the `safeContent` chokepoint), and it carries three known debts: (1) timeout waits but never kills — `executor.ts:94-103` uses `Promise.race` to bound the wait, giving up on the wait at the deadline while the handler keeps running (the `:93` comment — "timeout bounds execution duration from the outside, not relying on cancel support inside the handler"; translated from the code comment — records an **intentional design intent**); (2) cancel relies on handler voluntariness — the executor passes the signal through untouched (`:87`), and of the 5 tools only shell_exec listens (passing `ctx?.signal` into `exec()`), while the other 4 handler signatures do not accept ctx; (3) `isJsonCompatible` (`:38-48`) is too permissive — NaN/Infinity pass via typeof number (JSON.stringify silently turns them into null), Date/Map/Set/class instances are misjudged as compatible because `Object.values` returns an empty array (JSON-izing drops the data as `{}`), and circular references make the check itself overflow the stack. Platform limit: Node.js cannot forcibly interrupt executing synchronous code; only external processes and pending operations can be terminated. Operator ruling in the 2026-08-04 grilling.

## Decision

**B-1 (merging Q6+Q7): one unified stop signal governs timeout and cancellation.**

1. The executor issues one unified **AbortSignal** per tool call, merging two triggers: timeout deadline -> fire the signal -> return "timeout"; user cancel -> fire the same signal -> return "cancelled". The four-way stop-reason distinction (none/callerAbort/timerTimeout/hostCancel) reuses the existing `cancelKind` definition in CONTEXT.md — nothing newly invented.
2. Tools respond in two classes: **tools with subprocesses** (bash, grep) must listen to the signal and kill the subprocess on receipt — SIGTERM -> wait 2 seconds -> SIGKILL, with `detached` + negative pid **killing the entire process tree** (cleaner than killing a single level, closing that gap); **pure local-operation tools** (read_file/glob/edit_file/write_file) receive the signal but have nothing to kill — the executor does not wait and the result is discarded.
3. **Overturns the current "wait, don't kill" design intent** (the executor.ts:93 comment) — replaced by executor-issues-signal + subprocess-bearing tools must cooperate by killing.

**B-2 (Q8): tighten isJsonCompatible into a whitelist + strict prototype check.**

4. Admit only: strings, booleans, **finite numbers** (NaN/Infinity/-Infinity explicitly rejected), arrays, **plain objects** (prototype === Object.prototype; Map/Set/Date/class instances all rejected).
5. Date explicitly rejected: no reliance on implicit toJSON magic; a tool that wants to express time must return a string deliberately ("explicit beats implicit").
6. Circular-reference defense: the check maintains a visited-object set (WeakSet); revisiting means rejection.
7. **Post-rejection handling = replace with a notice string, do not fail the call** (keeps current semantics). Rationale: avoid escalating a "return-value blemish" into a "whole-call failure" that triggers spurious model retries; whether to later escalate to call-failure is left as a future topic (the operator explicitly said "we'll discuss escalation later").

**Why not alternatives**:

- _Separate signals for timeout vs cancellation_: from the tools' perspective both actions are identical (stop + clean up); distinguishing them is the executor's job (different wording returned to the model); merging on the tool side lowers the implementation burden per tool.
- _Keep "wait, don't kill"_: an abandoned-but-still-running handler keeps executing in the background = resource leak + uncontrollable side effects (a bash command may be mid-file-write); "discard what cannot be killed" suffices for pure local ops, but subprocess-bearing tools must be truly killed.
- _Fail the call after rejection_: could misfire on third-party (MCP) tools, and failure triggers model retry loops; a notice string lets the model know "this result is unusable", which is enough. The escalation path stays open.
- _Let Date pass via toJSON_: implicit serialization is "magic" — behavior shifts silently whenever the serialization form changes; project principle: "explicit beats implicit".

## Consequences

- (+) Timeout/cancellation truly terminate subprocess-bearing tools (including process trees), eliminating the resource leak and side-effect runaway of "stop waiting but keep running in the background".
- (+) JSON gatekeeping becomes honest: NaN/Infinity/Map/circular references no longer corrupt silently, guarding against "the model receiving an empty `{}` shell of data".
- (+) The executor master gate is independently strict, laying the groundwork for MCP third-party tool onboarding (third-party return values are not bound by iknow; this gate must police itself).
- (−) Design-intent flip: the executor moves from "only bound the wait duration" to "actively terminate", and the tool contract changes with it (subprocess-bearing tools must listen to the stop signal) — all tool implementations and tests must sync.
- (−) "Discard what cannot be killed" means results are lost when pure local operations are cancelled — acceptable (such operations are instantaneous anyway, and in-flight closeout semantics already fill `execution_failed` on cancellation).
- (−) The notice-string approach after rejection is lenient toward "buggy tools" and may mask bugs — an escalation path (switch to call-failure) is kept as a future topic.

**Evidence pointers**:

- The B-1 / B-2 resolution comments on the GH issue (2026-08-04).
- `src/harness/tools/executor.ts:38-48` (isJsonCompatible current state) / `:86-103` (timeout/cancel current state) / `:93` (the design-intent comment being overturned).
- Reference: `tools/bash_tool.py:55-100` (wait_for -> SIGTERM -> 2s -> SIGKILL, single level only); iknow adds process-tree kill.
- CONTEXT.md `cancelKind` four-value enum + `in-flight closeout` semantics (the stop-reason distinction is reused, not reinvented).
- Related ADRs: 0004 (tool set) / 0006 (capping policy — the executor of this ADR is the enforcement body of contract X there).
