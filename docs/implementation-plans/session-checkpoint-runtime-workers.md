# Plan: Session checkpoint runtime, graph state, and owned workers

**Status:** Implemented and merged (harness layer) — plan B commits `da34fa386` and
`b3d8b3c91`, merged into the integration baseline `60968adb4`. Every task below is
recorded per acceptance clause because the harness half and the host half have
different owners: a clause is only `met` where a test on this branch proves it, and a
clause this layer cannot prove is recorded as **Open** with its one named owner, rather
than quietly counted as done. This plan owns the runtime / graph / worker facts and the
harness write-capture seam; the session host owns the persistence adapter that receives
them, and the joined acceptance round for issue #1182 owns the real-kill / fresh-reopen
proofs. No clause is claimed here and in
[plan A](session-checkpoint-storage-recovery.md) at once.
**Goal:** Make harness execution, live graph progress, and session-owned worker
lifecycle recoverable through the unified session checkpoint contract.
**Approach:** The harness emits runtime persistence requests at the accepted-input,
tool, compaction, graph, worker, and settled-turn boundaries defined by the spec. The
existing session host and its writer queue remain the persistence authority; this plan
does not introduce a second history or own session-host assembly. This worktree can
start alongside the storage/recovery and final-request-trace plans against the shared
behavioral port contract; exact shared TypeScript shapes can be reconciled after merge.
**Spec link:** [Native session checkpoints, recovery, and effective-input
trace](../../specs/session-checkpoint-architecture.md)
**Decision sources:** The approved spec and existing ADR-0047, ADR-0101, ADR-0102,
ADR-0108, ADR-0110, ADR-0111, ADR-0126, ADR-0134, and ADR-0135, plus the accepted
[ADR-0136](../adr/0136-native-session-checkpoint-architecture.md).
**ACR:** all-yes — reviewed against the approved architecture contract on 2026-10-03;
this is not implementation or product-test evidence.

- bounded-context-guardian: yes — runtime requests cross one neutral port; the harness
  does not import `session-api`, and worker transcripts retain their own authority.
- input-contract-tests: yes — invalid/missing persisted state, concurrent settlement,
  and persistence exceptions have binary acceptance in the spec.
- error-handling-enforcer: yes — recovery-critical writes block dependent execution;
  trace best-effort behavior is owned by the trace plan.
- complexity-anti-drift: yes — capability work is sliced by loop, graph, and worker
  behavior without prescribing a monolithic implementation.
- minimal-change-verifier: yes — this plan covers only the approved runtime, graph, and
  owned-worker contract.

**Per-bullet implementation loop:** `arthurpower:test-driven-development` (RED → GREEN)
→ `npm run typecheck`, `npm run typecheck:tests`, and focused Vitest tests for the
affected existing surface. Do not invent test paths in advance; place tests with the
owning surface and use real filesystem/child-process boundaries where the spec requires
them.

## Tasks (ordered by dependency)

1. **Persist accepted-input and tool-batch runtime progress** — tag: `[implementation]`
   - **Inherits:**

     > “After a user message passes existing admission and is accepted into a persistent
     > session, publish a complete checkpoint containing that message, its assembled
     > native context, and required execution state before issuing the first model
     > request. Recovery keeps the input but does not resend the request automatically.”

     > “Persist each settled tool result and applicable per-file associations promptly.
     > Publish the next full checkpoint only when all calls in that tool batch have
     > returned and their results have been incorporated into the saved context. A
     > returned error is settled; an in-flight or unknown outcome is not.”

     > “complete assistant tool requests are committed before any call in that response
     > is dispatched. Only a complete successful assistant response may dispatch its
     > tools; incomplete or non-success supplier responses follow ADR-0111/ADR-0126, and
     > interrupted streams follow ADR-0108.”

   - **Surface:** Harness / Loop Engine in `src/harness/loop-engine.ts`, including the
     existing `commitMessages` seam and `executeWaveAndCommit` settlement/commit path;
     runtime assembly through `src/harness/build-engine.ts` (`buildHarnessEngine`) as
     needed. Session storage and CLI/session-host assembly remain with the
     storage/recovery plan.
   - **Acceptance:** The accepted user input produces an awaited full-checkpoint request
     before the first model dispatch. Each operation fact stays associated with its
     assistant tool-use identity, batch position, and base checkpoint; applicable
     per-file associations flow through the same port. A complete assistant tool
     request is committed before handlers start. A required persistence write failure
     starts no dependent handler. In a deterministic parallel wave, every independently settled
     result is appended promptly even when an earlier call is blocked; restart
     reconstruction places results in original protocol order. Returned tool errors are
     settled results, while in-flight or unknown operations stay unknown. No full batch
     checkpoint publishes until every result is incorporated into context. Covers SC2
     contribution and SC3–SC5; use the spec's real-filesystem/fresh-process and
     deterministic-barrier criteria.
   - Status: [x] implemented and merged (`da34fa386`, merged `60968adb4`), harness layer
     - Proven here: accepted input is published before the first model dispatch and the
       write is awaited; each settled tool result appends one fact carrying its tool-use
       id, batch position and batch size, so a result is durable while an earlier call of
       the same wave is blocked and protocol order is reconstructible; returned tool
       errors are settled; a batch is published as a whole state only once every result
       is in the context, never for a cancelled batch or a detached ADR-0134 handler; a
       rejected write blocks dependent execution via `RuntimeStatePersistenceError`.
       Tests: `tests/harness/loop-engine-runtime-state.test.ts` (16).
     - Open — owner: the host-side runtime persistence adapter (repair round #1182). At
       the merged baseline no host bound `RuntimePersistencePort`, so the accepted-input
       write had no producer and no fresh-process reopen; plan A's store and adapter exist,
       and the missing piece is the one adapter that receives this port's requests.
     - Open — owner: the harness write-capture seam. Per-file associations. The `files`
       field is in the port with its supplying layer named, but the kernel has no file
       view, so the producer is the layer that captured the preimage. At the merged
       baseline it had none: `RuntimeToolResultFact.files`
       (`src/shared/runtime-persistence.ts:138`) was never populated, so a settled write's
       `tool_result` fact and its `file_intent` record were two unjoined records of one
       effect.

2. **Save and restore exact compaction and terminal runtime context** — tag: `[implementation]`
   - **Inherits:**

     > “the exact saved native message sequence at the boundary,
     > including accepted user input, committed assistant/tool protocol messages,
     > settled tool results, host-injected context that belongs in the saved native
     > context, and the exact post-compaction context where applicable. Keep the native
     > recovery representation separate from masked trace evidence. Do not rebuild from
     > the transcript, current prompt/configuration, or a new compaction pass.”

     > “A settled terminal assistant turn can close a full saved state only after the
     > terminal record and message context are published and no tool operation remains
     > outstanding.”

   - **Surface:** Harness / Loop Engine compaction and turn closeout; the existing
     session assembly/runtime injection boundary may pass frozen session context and
     provenance through `buildHarnessEngine`. The session host selects and publishes the
     checkpoint.
   - **Acceptance:** After a compaction boundary, a fresh process restores the exact
     saved native context, and the earlier checkpoint remains selectable on its existing
     history branch; recovery does not run compaction, call the model, or reset
     completed progress. Required frozen session context, provenance, skill-index seen
     state, and logical continuation/mode state are available without consulting current
     settings. A terminal state is known only when the authoritative `turn outcome` is
     present and no operation is outstanding; missing outcome remains unknown. Covers
     SC6 and SC8. If this work changes model-visible prompt text, tool
     descriptions/schemas, or trajectory, apply `docs/guides/prompt-development.md` and
     its applicable golden-set process; otherwise record that no model-input surface
     changed.
   - [blocks: B1]
   - Status: [x] implemented and merged (`da34fa386`, merged `60968adb4`); three of the four named inputs stay open and are owned by the host, not by this plan
     - Proven here: compaction publishes the exact post-compaction array on both the
       proactive and the reactive path; the terminal publication carries the observed
       stop reason and never a completeness verdict, which stays the host's call under
       ADR-0126; a frozen `systemPrefix` is attached to every publication from the same
       seam the model request was sent on, so no two publications of one run can disagree.
       Tests: `tests/harness/loop-engine-runtime-state.test.ts` (16),
       `tests/harness/loop-engine-runtime-state-assembly.test.ts` (7).
     - Open — owner: the host-side runtime persistence adapter (repair round #1182).
       `provenance`, `skill-index seen state`, and `logical continuation/mode state` have
       no producer at this layer: the kernel sees only the current round's index delta,
       never earlier entries, and holds neither the session's continuation state nor the
       graph-mode state. The host owns all three and supplies them through the `runtimeFacts`
       bag it already declares empty (`src/cli/chat-session.ts:3003`); this port names the
       supplying layer for each field rather than shipping them unpopulated. `provenance`
       rides inside the published `messages` as the host-injected stamps the engine already
       writes, but the contract does not state that, so a reader cannot verify it from the
       port alone.
     - Open — owner: joined acceptance (#1182). "Available without consulting current
       settings" is a fresh-process reopen claim (SC6/SC8's reopen halves) and is unrun.

3. **Persist graph outcomes and outputs without replay** — tag: `[implementation]`
   - **Inherits:**

     > “persist the session's validated live graph state, settled node outcomes, and
     > outputs needed by later nodes. Completed or failed nodes must not be re-run
     > merely because the process restarted. An active or interrupted node stays
     > pending/unknown until explicit handling. Do not introduce a universal
     > `nextNodeIds` field; continuation is derived from validated graph state and
     > existing scheduler semantics.”

   - **Surface:** Harness live graph orchestration, including the existing live graph
     ledger and graph tool/scheduler path; runtime assembly through
     `src/harness/build-engine.ts` (`buildHarnessEngine`) where the session-owned
     persistence port is injected.
   - **Acceptance:** A real graph fixture settles both successful and failed nodes with
     outputs, terminates the host, and reopens in a fresh process. Settled outcomes and
     required outputs remain queryable; completed nodes are not respawned, and
     unresolved nodes are not silently run. Covers SC15. Preserve ADR-0047's
     session-level graph authority and use the shared persistence port rather than a
     second graph journal.
   - [blocks: B1] [parallel]
   - Status: [x] implemented and merged (`da34fa386`, merged `60968adb4`), harness layer
     - Proven here: node facts are written per node at its own settlement point instead of
       in one post-convergence pass, which is where a kill inside the scheduler used to
       lose every already-settled node; a dispatched node is marked before the spawn, so
       an interrupted node is distinguishable from one that was never submitted; a failed
       node carries its error; the cancel rule, the string-output rule and the
       `skipped` rule have a single definition that both the ledger freeze and the fact
       call. Tests: `tests/harness/graph/graph-runtime-state-persistence.test.ts` (17),
       plus the untouched `tests/harness/graph/` suite (261).
     - Open — owner: the host-side runtime persistence adapter (repair round #1182), for
       the persistence half, and joined acceptance (#1182), for the proof. The
       fresh-process kill + reopen half of SC15, including refusing to respawn completed
       ids and refusing to silently run unresolved ones, needs an adapter that persists
       these facts and rebuilds graph state from them; neither exists in the merged tree.

4. **Stop and reconcile session-owned workers safely** — tag: `[implementation]`
   - **Inherits:**

     > “On abnormal host exit, stop all subagents owned by that host, including
     > `wait:false` workers. Persist enough stable spawn/task and OS process-group
     > identity to verify that the exact owned worker has stopped; a PID alone is
     > insufficient because it may be reused. Never signal a process after its identity
     > no longer matches the owned worker. Before permitting explicit continuation from
     > a worker transcript, prove the former worker process is stopped.”

     > “Preserve each worker's persisted transcript; never recreate its in-memory
     > process state. Do not apply this policy to unrelated/persistent background Bash
     > services governed by ADR-0134/ADR-0135.”

   - **Surface:** Existing subagent manager, worker transcript, and worker
     process-entry/lifecycle surfaces, including the CLI worker entry if required for
     the death handshake; coordinate session-host abnormal-exit and reopen calls with
     the storage/recovery plan. This plan does not own CLI/session-host assembly.
   - **Acceptance:** Before host termination, the parent runtime state retains
     worker/task identity, foreground/background ownership, and the worker transcript
     reference/latest persisted progress. With real child processes for a foreground
     worker and a `wait:false` worker, abnormal parent termination must stop both owned
     children with confirmation of their original process identities. A separate injected
     cleanup/verification failure visibly leaves the affected worker `needs handling`;
     this negative case does not satisfy the normal stop guarantee. Continuation from a
     worker transcript is blocked until its exact prior process identity is confirmed stopped.
     An uncertain terminal record never becomes “complete,” a returned spawn handle
     never becomes a restored live process, and a reused PID with a different identity
     is not signaled. Worker transcripts remain independently readable and their event
     order is not merged into the parent transcript. Unrelated/persistent Bash services
     keep their existing lifecycle. Covers SC16–SC17.
   - [blocks: B1] [parallel]
   - Status: [x] implemented and merged (`da34fa386`, merged `60968adb4`), harness layer
     - Proven here: a per-task identity record captures pid plus `/proc` start time, so a
       recycled pid is never signalled and an unreadable identity is a needs-handling
       answer rather than a "stopped" one; the worker is not detached, so the
       process-group helpers are deliberately not reused (this worker shares the host's
       group, and signalling it would take the host down too) — liveness is pid-granular
       and the start-time read plus the evidence vocabulary carry over instead; the stop
       evidence reports whether a signal was actually delivered, derived from the
       delivery outcome rather than a literal; a verdict that failed to reach disk is
       surfaced as unrecorded instead of reported as proven; continuation is refused until
       the exact prior process is proven gone. Real child processes, including a real
       intermediate host process that exits without running `shutdown()`.
       Tests: `tests/subagent/worker-identity-{record,stop,abnormal-exit}.test.ts` (39).
     - Open — owner: the session-host entry path (repair round #1182). The abnormal-exit
       hook that calls `stopOwnedWorkers()`, the reopen sweep that presents
       needs-handling to the operator, and re-registering tasks in a fresh process so a
       recovered worker is continuable. None of the three has a producer in the merged
       tree: `stopOwnedWorkers()` is exported with no caller, and `resumeTask`
       (`src/harness/subagent/manager.ts:2811`) still gates on the in-memory task map, so
       a recovered task refuses with `not_found`.

5. **Keep recovered execution under current permission rules** — tag: `[implementation]`
   - **Inherits:**

     > “A later explicit operator action uses the existing continuation contract and
     > current permission rules. Process-local permission grants are not restored from
     > metadata.”

     > “Do not serialize API credentials, secret values, or the in-memory
     > secret-roundtrip registry.”

   - **Surface:** Harness permission execution and recovered runtime assembly through
     the existing permission chain; no new permission registry or session setting.
   - **Acceptance:** Reopening a checkpoint does not restore any process-memory
     `allow-once` grant or secret-roundtrip state. An explicit later tool action still
     passes the normal current permission chain and may require a fresh human decision.
     Covers SC18 and verifies the runtime portion of the normal-permission contract.
     **[parallel] with B1–B4; included in the combined host acceptance.**
   - Status: [x] proven rather than implemented (`da34fa386`, merged `60968adb4`)
     - Proven here: the port carries no field able to hold a permission rule, a secret or
       a credential; no persistence-building code path references `SessionGrants`,
       `SecretRegistry` or the credentials modules; a runtime built on an empty grant
       store re-asks through the current chain and a decline blocks the call.
       Confirmed live as well as statically: a real TUI turn granted `bash` for the
       session, the host was SIGKILLed, and after a fresh-process reopen of the same
       session the next `bash` call asked again.
       Tests: `tests/harness/permission/saved-state-excludes-grants.test.ts` (11).
     - Open — owner: joined acceptance (#1182). The reopen half of SC18 and the SC24
       normal-permission host acceptance.

## Local evidence and combined acceptance

Existing verification anchors include `tests/harness/loop-engine-commit.test.ts`,
`tests/harness/loop-engine-occupancy-compaction.test.ts`,
`tests/harness/graph/live-graph-ledger.test.ts`,
`tests/harness/graph/run-graph-ledger.test.ts`,
`tests/harness/graph/run-graph-concurrency.test.ts`, and
`tests/subagent/manager.test.ts`. Extend the relevant coverage for the new contract;
existing ordered-shutdown or in-process tests do not prove abnormal-host recovery.

Each bullet's local result reports its covered SC IDs, exact commands, fixture and
process boundaries, observable persisted records/results, and `pass`, `fail`, or `not
run`. Store fixtures in isolated temporary directories with fresh session identities;
use real child processes for worker death and recovery criteria. Local harness tests
establish only this plan's behavior: they do not prove that the separate storage host,
trace reader, and runtime port work together.

This plan contributes SC3–SC6, SC8, SC15–SC18, and its SC26 model-input review. It
contributes to SC2 at the harness boundary. The combined acceptance owns shared SC1a,
SC9a, SC27 and the end-to-end portions of SC1–SC2; follow the complete criterion text in
the spec rather than treating a plan-local pass as joined proof.

**SC26 result, recorded after the merge:** this plan changed model input with three
strings, not one. The `prior_process_unconfirmed` continuation refusal carries
`tests/subagent/subagent-continue-refusal-text.test.ts`; the two `undurable` node-failure
sentences this plan added to `src/harness/graph/run-graph-tool.ts` carry
`tests/harness/graph/graph-undurable-text.test.ts`, and their trajectory gap is registered
on the graph row of `docs/guides/prompt-development.md`. No tool description, tool schema,
or system prefix changed, and the operator-only recovery status copy is not model input.

After all three worktrees are integrated, run the SC25 shared acceptance round: `npm test`;
the spec's normal-permission persistent TUI/session-host PTY interaction for SC24; and a
central pass/fail evidence matrix for SC1–SC24, SC1a, SC9a, and SC26–SC27. The matrix
records the command or reproducible host interaction, fresh-process/filesystem evidence,
and any model-input golden-set result; report unrun checks with their reason. Do not use
`eval-state` or `--yolo` as evidence.

At the end of that combined round, run `arthurpower:code-review` once for the integrated
change; if it returns `GATE: BLOCKED`, run `arthurpower:review-report-repair` in the
next slot; then run `arthurpower:verification-before-completion` once against the
complete acceptance matrix. These are the joined delivery gate, not per-bullet checks.

## Persist list

None. This plan inherits the spec and ADR-0136 and adds no domain term or independent
architectural decision. Shared-file edits can overlap the other two worktrees; merge
coordination must preserve one persistence authority and one behavioral port.
