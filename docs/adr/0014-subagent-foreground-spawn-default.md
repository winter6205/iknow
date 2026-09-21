# 0014. Subagent spawn semantics: foreground-synchronous becomes the default contract, the async arm is downgraded to an explicit option

Date: 2026-08-11
Status: accepted

## Context

After subagent V1 (draft PR) landed, real-path e2e (real LLM + chat pipe, trace as ground truth) surfaced two compounding problems:

1. **Missing guidance layer**: `spawn-subagent-tool.ts`'s description states only the mechanism, not the timing, and the system prompt has no coordinator section; across 4 e2e traces there were 0 spawn calls — the main agent did the work directly via bash/read and fabricated "subagent status ok" in its final answer (hallucination).
2. **Deadlock in the closing layer**: V1's only contract was "spawn returns task_id immediately; the host drain injects results into priorMessages at the next `run()` boundary". That contract implicitly assumes "a next turn always exists", but in the chat pipe each stdin line = one run(); when a turn ends with no further input, the drain never fires -> worker results stay stranded in the buffer forever and the main agent never receives them.

Async fire-and-forget demands the higher-order model capability of "keep orchestrating after spawn, remember to come back for results", which testing proved current models do not reliably have. Established agent tooling defaults to **foreground synchronization**; its async drain blocks polling until terminal state rather than passively deferring to the next turn.

## Decision

Product shape chosen: **shape 2 (model-driven auto-spawn)**, contract inverted + guidance layer added, phased:

1. **Default contract = foreground synchronous**: `spawn_subagent` gains a `wait` parameter, default `true` -> the handler `await manager.waitFor(taskId, { timeoutMs })` internally, and the worker envelope returns directly as the tool_result — closed within the same turn. The "next turn" assumption is structurally deleted.
2. **The async arm stays as an explicit option** (`wait:false`): during the transition, the drain gains blocking polling (until at least one worker reaches terminal state), fixing result loss in pipe mode; the end state is V2's **event-driven wake-up** — a host watcher monitors workers and, on terminal state, the host self-initiates a run() that injects results to wake the main model, without depending on user input.
3. **Guidance layer is mandatory**: the description follows the task-tool style of stating timing ("Use proactively for multi-step exploration, independent verification, or parallelizable work") + foreground semantics ("call blocks until finished; issue multiple calls in one turn to parallelize"); the system prompt gains a ~30-line standalone coordinator slot through the `identity/assemble.ts` pipeline. Wording uses "blocks and waits by default" to leave room for V2's async-discipline section.
4. **Cost convergence**: `aci.timeoutTier` is raised from `fast` to the long-running tier; signal abort propagates to terminate the worker (in-flight closeout semantics unchanged); foreground results travel as tool_result through contract X executor truncation (ADR-0006 20000 cap); a constant cap on concurrent workers (suggested 4).
5. **Spec revision**: V1 spec's "immediately returns task_id" promise becomes "foreground synchronous by default, `wait:false` is the async option".
6. **Acceptance discipline**: real-path e2e asserts that a spawn_subagent tool_call appears in the trace; `messages_captured` asserts that the system prompt actually seen by the model contains the proactive keywords.

## Considered Options

- **Shape 1 (user-explicit trigger only)**: fixes only the drain deadlock. Minimal change, but the subagent capability amounts to wasted work — the model would never proactively use it. Rejected.
- **Shape 3 (env-gated hybrid)**: only with `IKNOW_COORDINATOR_MODE=1` inject the coordinator prompt + activate the tool. Doubles the prompt/test matrix, while "no manager -> no tool assembly" is already a visibility gate. Rejected.
- **Keep the async default + implement event-driven wake-up directly**: wake-up needs a self-initiated-run() channel across three entry points + silent-discipline guidance + wake-up message semantics discrimination — heavy machinery; if guidance fails, the degraded shape is worse than foreground (foreground failure = slow; wake-up failure = back to hallucination). Filed as V2 rather than the first step. Rejected (deferred).
- **Cut the async arm, keep only foreground**: the parallel multi-task scenario (multiple spawns in one turn already cover worker parallelism, but the main agent's orchestration of "dispatch work, then do something else") still needs the async path. Retained as an explicit option. Rejected.

## Consequences

- (+) The drain deadlock, the polling anti-pattern, and the incentive to hallucinate are all eliminated structurally: results return in-turn; there is no "wait for the next turn".
- (+) With the guidance layer added, the capability actually gets used; acceptance assertions guard against prompt/semantics drift.
- (+) All V1 parts (manager / worker / envelope / drain) are kept — only the default contract is inverted, not a teardown-and-redo.
- (−) The main agent cannot do other work while waiting for a worker; the UI blocks from seconds to minutes and needs worker-progress display (turn count / current tool) to mitigate.
- (−) Breaks V1 spec's original promise; spec and tool description must be revised.
- (−) Proactive guidance increases spawn frequency and token cost, converged via maxTurns/timeoutMs defaults and the concurrency cap.
- Rollback = flip the `wait` default back to async + restore passive drain injection; the guidance layer and acceptance assertions are independent of that rollback.

## Amendment (2026-08-29)

Event-driven wake-up is no longer a deferred item of this ADR. The default contract remains foreground spawn; the background arm in chat / tui / serve delivers terminal states via the mailbox, with the host self-initiating `run()` to inject the host-drained condensed result. ask does not assemble that channel. The `run()` boundary no longer blocks-polls for "at least one terminal state".

## Amendment (2026-09-18)

Omitting `wait` still = foreground; background happens only when the model explicitly passes `wait:false`. Background completion relies solely on the mailbox; using sleep / polling / fake checks as a completion protocol is forbidden. Rejected: making `wait` required in the schema; flipping the omitted default to background (including aligning with newer agent-tool versions whose Agent default is background); fixing "forgot to pass wait:false" by lengthening the description. Reasons: the in-turn closed loop of foreground remains the wanted pattern; when to go background is tied to model capability and should not be chosen on the model's behalf by the harness; `docs/guides/prompt-development.md` is a guide, not a gate, and the current description already states `wait:false` + mailbox. An idle turn is not the same as foreground binding the parent to this hop. Same-turn multi-spawn and the parent model's `subagent_stop` are covered by ADR-0101, not expanded here.

## Evidence pointers

- The real-path e2e issue — measured evidence (0 spawns across 4 e2e traces, the hallucination report) and root-cause analysis.
- V1 implementation issue / draft PR — V1 implementation (worktree `spec-356-subagent-v1`: `src/harness/subagent/` spawn-subagent-tool / host-drain / manager / worker).
- `src/cli/chat-session.ts` — the drain call site (priorMessages injection at the run() boundary).
- The "Use proactively" timing-guidance paradigm from prior art (exact adopted wording in Decision 3).
- `docs/CONTEXT.md` — the host drain and foreground spawn / background spawn entries.
