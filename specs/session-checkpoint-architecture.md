# Spec: Native session checkpoints, recovery, and effective-input trace

**Status:** Design complete — architecture-change review all yes

**Scope:** Persistent native sessions, their recoverable execution state, per-file recovery evidence, and actual model-request trace evidence

**Implementation:** Not started; this document defines the contract, not current runtime behavior.

## Objective

Make a newly created persistent native session recoverable after its host process exits unexpectedly. Recovery must restore the last published native execution state, preserve verifiable completed effects, show unresolved work to the operator, and never repeat a model request or tool operation merely because the session was opened.

The session remains the lifecycle boundary. Its append-only history is authoritative; checkpoints identify complete saved execution states; intermediate records account for progress between those states; trace records explain the actual inputs and calls; immutable content references avoid duplicate bodies. These are coordinated roles in the existing session architecture, not a second conversation history or a parallel execution engine.

## Assumptions and confirmed decisions

Every assumption used below is either an operator-confirmed direction already recorded in the active architecture tickets, or an existing workspace contract. None requires another product decision before planning.

1. **Confirmed — adoption applies to new sessions.** Keep existing session data. Do not migrate it or implement compatibility with the previous session mechanism; do not fabricate missing runtime state. Basis: `tsa-6-transition-and-acceptance.md`, 2026-10-03.
2. **Confirmed — session lifetime owns retention.** Do not expire checkpoint, trace, or referenced session content by age or quota. Explicit deletion of a session may remove its records and session-local content together. Basis: `tsa-5-integrity-and-data.md`, 2026-10-03.
3. **Confirmed — the existing session is the storage and history authority.** Reuse its event identity, parent, head, serialization, checkpoint, and persistence mechanisms. Keep one host-process writer per session data file and the existing assembly-level serial queue. Cross-process concurrent opens remain unsupported. Basis: `tsa-1-purpose.md`; ADR-0027 and ADR-0110.
4. **Confirmed — save accepted input before model execution.** After a user message passes existing admission and is accepted into a persistent session, publish a complete checkpoint containing that message, its assembled native context, and required execution state before issuing the first model request. Recovery keeps the input but does not resend the request automatically. Basis: `tsa-3-evidence-model.md`, 2026-10-03.
5. **Confirmed — tool-batch boundary.** Persist each settled tool result and applicable per-file associations promptly. Publish the next full checkpoint only when all calls in that tool batch have returned and their results have been incorporated into the saved context. A returned error is settled; an in-flight or unknown outcome is not. Basis: `tsa-1-purpose.md` and `tsa-3-evidence-model.md`.
6. **Confirmed — compaction preserves prior state.** Keep prior history and checkpoints. Save the exact post-compaction native context as a new selectable checkpoint on the session's event-history branch. Do not prune history or replay prior tools. Basis: `tsa-1-purpose.md` and `tsa-3-evidence-model.md`.
7. **Confirmed — session-owned subagents stop with an abnormal host exit.** This includes foreground and background subagents. Keep already persisted worker progress and verify the former worker has stopped before explicit continuation from its transcript. This does not change unrelated or persistent Bash service lifecycle. Basis: `tsa-3-evidence-model.md`, 2026-10-03; ADR-0101, ADR-0102, ADR-0134.
8. **Confirmed — actual request evidence.** For each governed model call, retain the actual final system instructions, complete advertised tool definitions, and effective ordered messages sent at the final adapter-request boundary. Store immutable represented bodies and reference them from that call's trace. Basis: `tsa-3-evidence-model.md`, 2026-10-03.
9. **Confirmed — use existing trace masking and reading.** Mask before content addressing; distinguish transformed or unavailable evidence. Copying a trace for independent reading requires that trace file and the immutable bodies it references. No new export command or UI is requested. Basis: 2026-10-03 discussion; ADR-0036 and ADR-0071.
10. **Confirmed — no new automatic task execution.** Opening a session may reconcile saved state and display status, but it does not restart a model request, retry a tool, or continue a worker. Any continuation is a later explicit operator action. Basis: `tsa-1-purpose.md` and `tsa-3-evidence-model.md`.
11. **Inherited — normal native permission posture.** Production chat/TUI execution retains its ordinary permission fence. Permission grants held only in process memory are not restored; any later execution is evaluated under the current permission rules. Evaluation and `--yolo` postures are not used as acceptance evidence. Basis: the Wayfinder map; ADR-0119 and ADR-0130.
12. **Inherited — separately scoped file rewind.** Crash recovery reconciles effects; it does not perform manual code rewind. Existing safe rewind rules in ADR-0121 continue to govern explicit rewind, including task-root identity checks, drift handling, and refusal to invent chronology across transcript writers.
13. **Inherited/derived — settled terminal boundary.** A terminal full-state snapshot may close progress only when the existing authoritative `turn outcome` is published and no operation remains outstanding. This follows ADR-0126; it is not a newly confirmed checkpoint for every model response.
14. **Derived — one neutral persistence seam.** The harness requests persistence through one dependency-neutral port, while the session host implements it through the existing single-writer queue. This preserves ADR-0110 and the harness/session-api boundary; it does not create another journal.
15. **User-directed — parallel plan partition.** Produce three capability plans in separate worktrees, with one combined acceptance result. All worktrees implement this spec's single behavioral persistence-port contract in parallel; physical shared types may be reconciled during integration, without a fourth foundation plan or a pre-landing barrier. Basis: the latest user instruction.

## Boundaries

- **Does:**
  - Persist a complete native recovery state at the accepted-user-input boundary, settled tool-batch boundary, successful compaction boundary, and a settled terminal-turn boundary when the authoritative `turn outcome` exists and no operation remains outstanding.
  - Define the saved state needed to reopen the session without reconstructing it from the full transcript or current settings.
  - Coordinate session events, immutable native state, intermediate execution records, tool results, graph state, worker transcripts, per-file operation evidence, and actual-request trace references.
  - Reconcile abnormal exits automatically when the operator opens the corresponding new-format session, with a visible progress and completion/handling status.
  - Make ordinary captured file writes atomic per file and preserve each verified completed file effect after interruption.
  - Capture final effective system instructions, full advertised tool definitions, and ordered messages for each governed model call using the existing trace redaction and read path.
  - Define deterministic filesystem, fresh-process, parallel-settlement, trace-reader, and normal-permission host acceptance evidence for later implementation.
- **Confirms with human:** (none; prior product decisions and inherited workspace contracts cover this specification.)
- **Out of this spec:**
  - Migration, compatibility, or recovery support for sessions created by the old mechanism. Existing files remain untouched by adoption.
  - Evaluation frameworks, a fresh evaluation pilot, `eval-state`, and `--yolo` acceptance runs.
  - Automatic retry/replay, deterministic replay, rollback of Bash/network/other external effects, filesystem watchers, a shadow repository, or a workspace-wide snapshot.
  - Changes to manual transcript rewind or its existing optional code-restore behavior.
  - A new trace export command/UI, global content store, cross-session deduplication, expiry, quota GC, selective content pruning, or independent record deletion.
  - Recovery or restoration of process-local permission grants, timers, abort signals, streams, promises, and live process handles.
  - A power-loss/fsync guarantee beyond recognizing only complete, published records as saved progress. The acceptance contract covers host-process termination after persistence calls report completion; it makes no claim about storage that the operating system has not made durable.
  - New symlink/hardlink, special-file, or metadata-preservation semantics for atomic file replacement.

## Contract

### 1. Authorities and ownership

The **session transcript** remains the authoritative append-only history and sole persisted branch/history authority. Its existing event IDs, parent links, and selected rewind head define reachability. A checkpoint is a reference to a published native state anchored in that existing history; it is not a second message log. Runtime state and immutable bodies are payloads referenced from session-owned records, not another mutable journal.

The session host owns checkpoint selection, publication, entry recovery, visible status, and coordination through the existing per-session writer queue. The storage adapter persists checkpoint payloads and operation facts. The harness emits typed runtime persistence requests through one dependency-neutral port in an existing neutral layer; it must not import `session-api` or own session file formats. The host injects the port and routes writes through the same single-writer boundary. This spec freezes the port's behavioral contract; the exact shared TypeScript representation may be reconciled when separate worktrees integrate. Parallel implementations must converge on one contract and authority, not create a second store or global journal.

Each worker transcript remains its own append-only history and single-writer surface. The parent session stores task identity, ownership, and references to worker progress; it does not merge worker events into the parent transcript or impose a timestamp order across writers. The project-level background task registry and persistent Bash service retain their existing lifecycle contracts.

The immutable content pool is session-local. Identical represented content within one session may reuse an immutable body. Different sessions remain independent. Raw native recovery state, trace-redacted evidence, and any differently transformed representation must remain distinguishable and must not be interchanged by a reader. Existing raw `code-snapshots/` remain the file-preimage store; this spec does not move raw code preimages into the trace-body directory.

### 2. Complete native recovery state

A published checkpoint must be sufficient to restore the exact native context and determine which work is settled, pending, or unknown. It must cover the following categories whenever they exist in the session:

1. **Conversation context:** the exact saved native message sequence at the boundary, including accepted user input, committed assistant/tool protocol messages, settled tool results, host-injected context that belongs in the saved native context, and the exact post-compaction context where applicable. Keep the native recovery representation separate from masked trace evidence. Do not rebuild from the transcript, current prompt/configuration, or a new compaction pass.
2. **Loop position:** stable session/turn identity and the minimum loop bookkeeping required to know whether a model request was started, whether its complete response was committed, which tool batch it produced, and whether that batch has settled and entered context. A checkpoint must never imply an in-flight request completed.
3. **Session assembly and provenance:** preserve the frozen session-level system/prompt prefix needed to assemble native context, its provenance stamps, and the skill-index seen set when present. Also preserve logical pending-continuation state and selected execution-mode state when used. These are native recovery inputs; they are not reconstructed from redacted trace. Do not serialize API credentials, secret values, or the in-memory secret-roundtrip registry.
4. **Tool progress:** complete assistant tool requests are committed before any call in that response is dispatched. Only a complete successful assistant response may dispatch its tools; incomplete or non-success supplier responses follow ADR-0111/ADR-0126, and interrupted streams follow ADR-0108. For each operation, preserve stable association to its assistant/tool-use event, batch position, base published checkpoint, returned result when available, and settled/unknown state. Append later facts; never mutate a published checkpoint. Historical tool definitions in trace are evidence, not executable tool definitions to restore after restart.
5. **Graph progress:** persist the session's validated live graph state, settled node outcomes, and outputs needed by later nodes. Completed or failed nodes must not be re-run merely because the process restarted. An active or interrupted node stays pending/unknown until explicit handling. Do not introduce a universal `nextNodeIds` field; continuation is derived from validated graph state and existing scheduler semantics.
6. **Subagent progress:** preserve task identities, wait/background ownership, terminal/pending state, and the worker's own transcript reference/progress. A returned `wait:false` spawn handle is a settled tool call but does not make the worker complete; checkpoint it as a live logical worker with its latest persisted progress. Never restore a process handle or infer completion from the spawn result.
7. **File-operation progress:** preserve current `taskRoot`/write-root identity references and each target's recorded write-root identity, relative target, captured preimage/expected postimage references, whether the path was absent before the operation, operation identity, and per-file publication status. A multi-file call has a separate association for every target.
8. **Terminal state:** use the existing authoritative `turn outcome` and its stable turn identity. Missing terminal outcome remains unknown, not `completed`. A settled terminal assistant turn can close a full saved state only after the terminal record and message context are published and no tool operation remains outstanding.
9. **Capture policy:** preserve the existing `codeRestore.enabled` opt-out. When capture is disabled, do not create new code snapshots or claim verified per-file progress; record/derive the capture-disabled state, keep native context and operation results, and treat the file effect as unverified on recovery. Do not add or change a setting in this spec.

Checkpoint selection must be deterministic from published checkpoint anchors reachable on the selected session event/head chain. Reuse existing event identity and parent/head semantics. Continue using `CheckpointRecord` / `appendCheckpoint` for checkpoint marker/index duties where appropriate; markers identify published state but do not contain its runtime payload or introduce an independent head. A derived in-memory selection or cache is allowed if rebuilt from that authority. Do not introduce an independent persisted `currentCheckpointId` clock, a parallel `branchId` registry, or a timestamp-based “latest” rule. The reviewed contract uses event-derived checkpoint lineage and one restoration anchor, without a separate `parentCheckpointId` or duplicate `fileRestore.anchorEventId`. File intents reference their existing operation/tool-use/event identity and carry per-file associations.

### 3. Publication and file-write protocol

Publication is ordered so that a record never points at incomplete or missing state:

1. For a complete checkpoint, write and validate all immutable state bodies first. Append/publish the checkpoint reference through the session's existing serialization boundary only after those bodies are complete. Only the published reference is selectable. Failure before publication leaves the prior checkpoint selected; an orphan immutable body is harmless and is not progress.
2. After a user message is accepted, persist its native context and publish the input checkpoint before dispatching the model call. If any required recovery body or publication write fails, surface the persistence failure and do not issue the dependent model request.
3. Persist a complete successful assistant response containing tool requests and its batch order before dispatching any of those tool calls. Do not execute tool calls from an incomplete/non-success supplier response; retain the existing ADR-0108/ADR-0111/ADR-0126 closeout semantics. For independent/parallel calls, append each settled result as soon as that call returns, even when an earlier call in the batch is still running. Preserve protocol order in the reconstructed model context; settlement order is not a substitute for tool-use order.
4. For each ordinary `edit_file`, `write_file`, or `symbol-mutate` target with the existing capture policy enabled, capture its preimage (or prior absence) and complete expected postimage. Persist both immutable bytes and the durable per-file operation association before touching the target. A failed evidence write fails the dependent file operation before mutation. When existing `codeRestore.enabled` disables capture, preserve that behavior: do not create code snapshots, do not block the otherwise permitted write solely to manufacture recovery evidence, and do not later claim the unrecorded file effect is verified.
5. For file-content writes suitable for replacement, stage the complete content on the same filesystem, then publish that one target with atomic replacement. This guarantee is per file; a multi-file operation is not a transaction. Keep already published file A if file B is interrupted. Do not expose a partially written target file.
6. Append each settled tool result and its per-file associations to the existing session record path promptly. A returned tool error is settled and is saved as an error result. A call still executing or whose outcome is unknown is not settled. After all calls in the batch have returned and all results have been incorporated into native context in protocol order, write the new immutable full-state body and publish the next checkpoint.
7. A worker or other asynchronous operation may remain logically active after its spawn tool returned. The full checkpoint records that active ownership and progress; it must not label the worker terminal. Its later progress remains in its own writer's transcript.
8. Successful compaction writes the exact new native context and publishes a checkpoint anchored to the new branch through existing session history. Retain the pre-compaction checkpoint and all referenced content. No prior operation is replayed or reset.
9. For a settled terminal model turn, publish the authoritative `turn outcome` before exposing that outcome as saved completion. When there are no outstanding operations, persist a terminal full-state snapshot so reopen does not infer completion from assistant text alone.

Complete progress means the required bodies, associations, and publication records completed through the session storage path. In-memory state alone is never progress. The neutral port and recovery reader report typed persistence/validation failures with bounded handling: a required write failure blocks dependent execution; an invalid selected checkpoint or unresolved integrity violation ends recovery in a visible blocked/needs-handling state. No empty catch, silent fallback, or unbounded retry is allowed. The trace writer retains its existing best-effort/non-throwing behavior; native recovery persistence is correctness-critical and must fail visibly before dependent execution proceeds.

### 4. Abnormal exit and session-entry recovery

Opening a selected new-format session automatically checks for an abnormal prior host exit or unresolved persisted operations. Recovery runs only for that selected session and displays a visible `recovery in progress` state. It selects the latest published checkpoint reachable on the chosen session event/head chain, validates and loads its native context, reconciles later operation facts with actual per-file contents and worker status, then exposes either `recovered` or `needs handling` with the affected operations/paths. If a required body for the selected published checkpoint is missing, corrupt, or schema-invalid, fail closed with a visible blocked/needs-handling status; do not silently fall back to transcript reconstruction or an older checkpoint that could discard published progress. An incomplete unpublished trailing record is ignored while retaining the prior valid published checkpoint. Recovery must not scan or rewrite unrelated sessions.

For every recorded file operation, use the captured root identity and durable association. When the file at that exact live write root equals the expected postimage, retain that verified per-file effect even if the tool's overall result is missing; carry that progress into the restored native context without inferring whole-tool success. When bytes still equal the recorded preimage, record that no file replacement was verified; the operation's overall outcome remains unknown if no result exists. If bytes match neither image, the root identity differs, a required blob is missing, or the same path has ambiguous ordering across transcript writers, do not overwrite, delete, or assign a synthetic chronology. Mark the item for handling. Existing ADR-0121 drift/root safeguards remain applicable.

For a partially completed multi-file operation, keep every independently verified published file, report each unresolved target, and do not roll back a completed target because a later file failed. A settled error result stays an error result. File agreement alone proves only that target's recorded effect; it never proves the entire operation succeeded.

On abnormal host exit, stop all subagents owned by that host, including `wait:false` workers. Persist enough stable spawn/task and OS process-group identity to verify that the exact owned worker has stopped; a PID alone is insufficient because it may be reused. Never signal a process after its identity no longer matches the owned worker. Before permitting explicit continuation from a worker transcript, prove the former worker process is stopped. If termination cannot be confirmed, show `needs handling` and block continuation of that worker. Preserve each worker's persisted transcript; never recreate its in-memory process state. Do not apply this policy to unrelated/persistent background Bash services governed by ADR-0134/ADR-0135.

Recovery is idempotent across repeated session opens. Reconciliation of an already classified operation must not duplicate its result/receipt, republish a checkpoint, repeat a file effect, or signal an unrelated process. If a prior recovery ended in `needs handling`, later opens preserve that status until an explicit handling action resolves it.

Session temporary working files need no extra snapshots: retain the existing session-scoped host directory, reread actual files on recovery, and allow missing or incomplete dispensable intermediates to be regenerated. Do not assume the operating system's general `/tmp` contents are session-persistent.

Recovery never issues model or tool calls. It does not resend the user input saved before a model call, automatically retry an unknown or failed operation, rerun compaction, continue a graph, or relaunch a worker. Use existing in-flight closeout rules to make interrupted protocol pairs readable; a process-closeout result does not prove that a mutating operation had no side effect. Before any later explicit retry, reconcile the possible effect under existing contracts. A later explicit operator action uses the existing continuation contract and current permission rules. Process-local permission grants are not restored from metadata.

Manual code rewind remains a separate explicit action under ADR-0121. Crash recovery does not reverse captured writes, Bash effects, or external effects. Uncaptured or unknown shell/external effects remain untouched and require read-only reconciliation or explicit operator handling before any retry.

### 5. Final-request trace and content reader

Capture the exact request object passed at model-provider/SDK dispatch, after all effective-message injections, compaction projection, instruction-authority projection, and tool-definition projection have been applied. The captured record must identify the exact ordered messages, actual system instructions, and complete tool definitions supplied in that dispatch object. Do not reconstruct this set from an earlier intermediate state, current settings, transcript deltas, or later tool-call events.

Each governed SDK invocation has its own call identity even when its request bodies reuse existing immutable references. Preserve that identity through success, streaming failure, or SDK rejection so evidence describes the actual attempted invocation rather than a reconstructed successful call. A trace capture or storage failure must not dispatch the request again; existing transport retry policy remains separate and any permitted additional invocation has distinct call evidence. This contract does not claim receipt by the provider or expose transport credentials and headers.

Store represented bodies in the existing session-local immutable content pool and reference them from the call's trace record. Identical represented bodies within the session reuse one immutable body; changed bodies receive new content; a digest without a retained body is not a valid reference. Apply existing masking/redaction before content addressing. Mark transformed, intentionally unavailable, or failed-to-capture evidence distinctly. Raw native recovery content and masked trace content remain separate representations with separate read authority and failure contracts. A trace writer/body failure is reported by existing trace-health semantics and does not fail the model call; a native-state write failure blocks dependent recovery-critical execution.

The existing trace reader follows references belonging to the selected trace. It must not expose native recovery bodies or enumerate/export every body merely because the physical pool is shared. Independent reading uses the trace JSONL plus exactly its referenced trace-permitted bodies in the existing relative layout. Existing read operations must continue to work; this spec adds no export UI, export command, or whole-session bundle. A copied trace without its referenced bodies is visibly incomplete rather than silently presented as full input evidence.

### 6. Transition and plan ownership

New-format sessions must be positively identifiable before the new loader or recovery path uses them. Existing old-format session files remain on disk and are not rewritten, migrated, or presented as complete new-format checkpoints. If an old-format session is selected, report that it is unsupported by the new recovery contract and offer the existing new-session path; do not erase it or synthesize missing state.

The unified contract is implemented in three capability plans, each in its own worktree, with one combined acceptance gate. Plan ownership for `writing-plans` is:

1. **Session persistence, per-file recovery, and host entry.** Cover the session writer, checkpoint selection/publication, file intent/atomic publish/reconciliation, entry recovery status, and non-migration transition behavior, including the persistent CLI/session host surfaces.
2. **Harness execution, graph state, and owned-worker lifecycle.** Persist loop/batch state through the port; preserve graph outcomes and worker references; enforce abnormal-host worker stop and pre-continuation process-death checks without merging transcript writers. This plan does not own the CLI/session host assembly.
3. **Final-request trace and trace reader.** Capture actual final adapter requests, retain masked bodies in the session-local pool, enforce trace-only reference access, and preserve the existing trace reader/portable-copy behavior.

All three worktrees may implement in parallel against the semantic contract in this spec, using external-boundary fixtures for session persistence, harness execution, and trace capture. Shared-file and physical-type conflicts are reconciled at integration; do not create competing persistence authorities or weaken the port contract to ease a merge. This section is the plan split, not an index or a fourth plan. Each plan reports local evidence, and the combined acceptance matrix below is run after integration; isolated plan tests do not prove the joined system.

The three tracked plans are [A: storage and host recovery](../docs/implementation-plans/session-checkpoint-storage-recovery.md), [B: runtime and owned workers](../docs/implementation-plans/session-checkpoint-runtime-workers.md), and [C: effective-input trace](../docs/implementation-plans/session-checkpoint-trace-evidence.md). They are documentation deliverables on the main branch; implementation belongs to later sessions.

## Success Criteria

All criteria are binary. These are future implementation gates; no product tests or crash-injection tests have been run for this draft.

### Shared persistence and recovery

- **SC1 — Published-state integrity:** for every injected crash point between immutable-body write and checkpoint publication, including a torn trailing JSONL append, a fresh host selects only the prior published checkpoint; it never follows a missing, partial, or unvalidated body. After a complete checkpoint publication, a fresh host loads that exact native snapshot.
- **SC1a — Invalid published state:** corrupt/remove/schema-invalidate the required body of the selected published checkpoint, corrupt a committed mid-log record, or provide an invalid selected event head. A fresh host visibly blocks recovery/marks it for handling, performs no model/tool/file execution or workspace change, and does not silently reconstruct context or select an older branch. This is distinct from SC1's incomplete unpublished tail.
- **SC2 — Accepted input boundary:** a real filesystem fixture accepts a user message, persists its complete input checkpoint, then kills the host before/during the first model request. On reopening in a fresh process, the accepted user message and exact saved context are present, recovery status is visible, and neither the model nor a tool is called by recovery.
- **SC3 — Tool response boundary:** a complete successful assistant tool-request response is persisted before any tool handler starts. An injected persistence failure prevents every dependent call from starting; an incomplete/non-success response dispatches no enclosed tool call and follows the existing closeout contract.
- **SC4 — Parallel settled results:** deterministic barriers allow later parallel calls to settle while an earlier call remains blocked. Each settled result is durably appended immediately; after restart, the result messages are assembled in original protocol order, and no unsettled call is represented as settled.
- **SC5 — Full batch checkpoint:** no full tool-batch checkpoint is published until every returned call, including error results, has been incorporated into the saved context. A crash before publication recovers from the base checkpoint plus the persisted intermediate facts and reports unknown/in-flight calls without retrying them.
- **SC6 — Terminal outcome:** a turn with an authoritative persisted `turn outcome` and no outstanding operations reopens with that same outcome. A missing outcome remains unknown and is never projected as completed from assistant text alone.
- **SC7 — Event-head authority:** tests create multiple session-history branches/checkpoints and prove checkpoint selection follows the selected reachable event/head chain deterministically. No timestamp ordering, independent mutable current-checkpoint pointer, or duplicate branch registry is required to recover the correct checkpoint.
- **SC8 — Compaction branch:** after compaction, a fresh process restores the exact post-compaction native snapshot, while the earlier history/checkpoint remains selectable on its existing branch. Recovery performs no compaction/model/tool replay and does not reset completed tool, graph, or file progress.

### File and temporary-state recovery

- **SC9 — Pre-write durability:** inject a snapshot/association write failure before a file operation; the target's bytes remain unchanged and the tool returns a visible failure.
- **SC9a — Capture disabled:** set the existing `codeRestore.enabled` policy to false without changing settings schema. The existing write path remains available, no new code snapshot is created, and a fresh process reports the effect as unverified/needs handling rather than inferring completion or retrying it.
- **SC10 — Per-file atomicity:** kill a writer before staged replacement and verify the target is wholly old; kill after replacement and verify the target is wholly new. A two-file fixture that publishes A and stops before B retains A, leaves B at its actual state, and reports per-file progress without an all-files rollback.
- **SC11 — Missing tool result:** publish a target's complete expected postimage, omit the overall tool result, then reopen. The target effect is preserved and its per-file progress is represented in restored context; the whole tool remains unknown and is not retried.
- **SC12 — Error and mismatch handling:** a returned error is restored as a settled error. Current bytes matching neither preimage nor expected postimage, mismatched write-root identity, missing required body, or ambiguous same-path ordering across transcript writers produces `needs handling` and leaves those bytes untouched.
- **SC13 — Session tmp:** reopening reads the current real session-tmp files without creating tmp checkpoints. Missing/incomplete dispensable tmp content does not masquerade as saved progress and can be regenerated by explicit subsequent execution.
- **SC14 — Rewind separation:** automatic crash recovery does not move the rewind head to undo file effects and does not weaken the existing `specs/code-restore.md` behavior for an explicit manual rewind.

### Runtime state and worker lifecycle

- **SC15 — Graph state:** a graph fixture settles nodes with both success and failure, kills the host, and reopens in a fresh process. Settled outcomes and required outputs remain available; completed nodes are not respawned; unresolved nodes are not silently run.
- **SC16 — Foreground/background subagents:** use a real child process for a foreground worker and a `wait:false` worker. After abnormal parent termination, prove both owned child processes are stopped before explicit worker continuation can proceed. The worker transcript remains independently readable and its chronology is not merged with the parent's.
- **SC17 — Worker uncertainty:** when process termination cannot be confirmed or the worker has no complete terminal record, recovery reports the worker as requiring handling; it never reconstructs a live process from a returned handle or marks a background worker complete merely because its spawn tool returned. A reused PID with a nonmatching process identity is not signaled.
- **SC18 — Permission freshness:** saved checkpoint/operation metadata never restores an `allow-once` or other process-memory grant. Any post-recovery tool action passes the current permission chain and can require a fresh human decision.

### Effective-input trace and reader

- **SC19 — Final-wire oracle:** with deterministic streaming and non-streaming adapter fixtures, the trace's dereferenced ordered messages, system instructions, and full tool definitions equal the exact request object received by the mocked provider/SDK dispatch for an unmasked request. Each dispatch has distinct call identity even when its bodies are shared, and an SDK rejection remains linked to that same attempted invocation with failure evidence. No earlier `effectiveState` or transcript reconstruction is used as the oracle.
- **SC20 — Redaction and representation:** for fixtures containing redactable values, the stored trace bodies equal the existing masker output, are marked transformed, and have distinct references from raw native recovery bodies. Two identical masked bodies share one stored body; a changed body produces a new reference.
- **SC21 — Trace failure contract:** inject a trace JSONL/blob failure and verify a successful SDK boundary is dispatched exactly once, trace health reports the failure, and no inline fallback falsely claims complete input capture. For an SDK rejection, retain failed-attempt evidence under the invocation's identity when the trace sink is available; when it is unavailable, report the evidence gap without an extra dispatch caused by the trace failure. Inject a native checkpoint/body failure and verify dependent model/tool/file execution is blocked before side effects.
- **SC22 — Trace reader access:** the existing trace reader dereferences all referenced trace bodies and returns the same record semantics. It cannot reach raw native checkpoint content through trace refs or broad pool enumeration. Copying only trace JSONL reports missing/incomplete referenced content; copying that trace plus only its referenced trace-permitted bodies restores the same readable view without a new export command/UI.
- **SC23 — Existing-session transition and retention:** opening an old-format fixture does not rewrite or delete any old bytes and does not claim new-format recovery. New-format sessions do not expire by age or quota; explicit session deletion removes only that session's records/content under the existing deletion contract.

### Combined delivery evidence

- **SC24 — Normal-permission host acceptance:** after all plans land, run the complete `npm test` product path and exercise a persistent native TUI/session host through the available PTY path under its normal permission fence: accept a user input, write a file, trigger an abnormal host exit at a controlled boundary, reopen the same session, observe recovery status, verify the accepted input and file progress, and confirm no automatic model/tool replay. SC15–SC18 separately cover graph, worker, and grant recovery. Do not use `eval-state` or `--yolo` as evidence.
- **SC25 — Central matrix:** the final report maps every SC1–SC24 plus SC1a, SC9a, and SC26–SC27 to an executed command or reproducible host interaction with evidence; fresh-process crash tests use real child processes and real filesystem state rather than only reconstructing objects in one process. Every criterion is pass/fail, and all three implementation plans contribute to one combined acceptance result.
- **SC26 — Model-visible prompt changes:** record whether implementation changes text supplied to the model. If yes, follow `docs/guides/prompt-development.md`, update/register the applicable golden set, and show its acceptance result. If no, the final diff review records that no model-input surface changed. Pure operator recovery-status UI copy does not count as model input.
- **SC27 — Repeated recovery:** open the same session twice after one injected abnormal exit, including once after `needs handling`. The second open adds no duplicate result/receipt/checkpoint, performs no repeated file mutation, makes no model/tool call, and does not signal an unrelated or reused process identity.

## Open Questions

(none that require operator input before planning. Final physical record fields, serialization/version tags, and the location of the neutral port are implementation details governed by the event/head and ownership contracts above; the plans must record their final choices without adding competing authorities.)

## Inherits / Changes

### Exact workspace terms

Quoted from `docs/CONTEXT.md`:

> **append-only messages**: Foundation's authoritative Anthropic-native conversation history and the sole source of message content. Messages are added immutably (`[...prev, x]`), never edited in place or copied into a second authoritative history; the **session transcript** projects them from JSONL events, while a separate **turn outcome** records each turn's terminal state.

> **turn outcome**: A terminal record in the **session transcript** for one settled host turn, linked by a stable turn identity even when no new user message was appended. It carries the authoritative **StopReason** and separate normalized supplier-stop detail without entering model-facing messages; a missing record means unknown, not `completed`. ADR-0126.

Other existing terms are used with their current definitions in `docs/CONTEXT.md`: **rewind head**, **session folder**, **content-addressed body pool (`blobs`)**, **code preimage**, **taskRoot**, **session tmp**, **worker transcript**, **graph state**, and **permission grant**. Their accepted target definitions and the scoped changes below are recorded in the glossary and ADR-0136; unchanged terms retain their existing meaning.

### Existing decisions and surfaces relied upon

- ADR-0027 — append-only session JSONL, event IDs/parents, selected rewind head, and transcript as history authority. The new recovery references extend this authority without storing a second message history.
- ADR-0036 / ADR-0071 — trace bodies are masked before content addressing, stored immutably per session, and read by dereferencing references; trace failure remains non-throwing. This spec extends the pool to native recovery representations while separating consumer access and failure contracts.
- ADR-0047 — live graph state is session-level authority and completed work must not be re-enacted. This spec changes its current in-memory-only persistence boundary.
- ADR-0101 / ADR-0102 — worker IDs, one writer per worker transcript, no injection into a live worker, and continuation only after process death. This spec adds abnormal host-exit stop/verification while retaining worker transcript ownership.
- ADR-0110 — one host-process writer per session data file and assembly-level serialization; no cross-process concurrent-open support.
- ADR-0111 / ADR-0108 — incomplete supplier responses and interrupted streams retain their existing closeout rules; no incomplete tool request is dispatched.
- ADR-0116 remains deprecated historical context for the earlier system/tool omission. The new final-request capture decision is recorded in accepted ADR-0136; this spec does not revive ADR-0116.
- ADR-0121 — existing raw per-write code snapshots and fail-safe explicit code rewind; these remain separate from trace/redacted blobs and from automatic crash recovery.
- ADR-0126 — terminal outcome is authoritative; absence means unknown. ADR-0108 and `specs/interrupt-frozen-prefix-keep.md` preserve existing in-flight closeout behavior.
- ADR-0134 / ADR-0135 — background Bash service and finite-task lifecycle remain separately governed.
- `specs/transport-continue-persist.md` — existing explicit retry/continue behavior remains the source for a later user action; session-open recovery itself issues no request.
- `specs/code-restore.md` — existing explicit rewind/code-restore remains separate and retains its path ownership, drift, blob-preflight, and live-root rules.
- `docs/guides/prompt-development.md` — required process if any model-visible prompt text changes.

### Current source baseline (read-only audit; not implementation evidence)

- `src/session-api/store/schema.ts` currently stores checkpoint index/interruption metadata, while `src/session-api/store/checkpoint.ts` publishes markers; this is not a persisted executable runtime snapshot.
- `src/session-api/store/preimage-capture.ts` captures per-write bytes, but its association ledger is in memory until transcript stamping. Current file operations are not an atomic multi-target transaction.
- `src/harness/graph/ledger.ts` holds live graph terminal state in memory and resets it on process resume. ADR-0047 assigns graph authority to the session but current code does not persist it.
- Parallel tool-result persistence in `src/harness/loop-engine.ts` currently writes an ordered settled prefix; the new contract requires each independently settled result to be persisted promptly while later context reconstruction preserves protocol order.
- Current trace capture observes an effective message state before all final adapter projection; ADR-0116 removed system/tool advertisement evidence. The new capture point and complete definitions are future work.
- Existing `code-snapshots/`, trace `blobs/`, session temp, worker transcripts, session serialization queue, and trace reader are reuse points, not proof that this new recovery contract already works.

These are source observations only. No code changes, product tests, fresh-process recovery tests, or crash fault-injection tests have been run for this spec.

### Persisted decisions

- [ADR-0136](../docs/adr/0136-native-session-checkpoint-architecture.md) records the accepted unified checkpoint, shared-content, and final-request-capture decision. Scoped notes identify the affected clauses in ADR-0003 D10, ADR-0035, ADR-0071 D3, ADR-0047, and ADR-0121 while preserving their unaffected contracts.
- The domain-modeling workflow has added **published checkpoint** and updated the existing body-pool, code-preimage, and effective-input terms in `docs/CONTEXT.md`. These definitions describe the accepted architecture; `docs/STATUS.md` retains the current implementation baseline.
- ADR-0116 remains deprecated. The three plans inherit these decisions and add no term/ADR delta; there is no remaining persist list for this documentation handoff.

## Architecture-change review

Reviewed on 2026-10-03 before plan authoring. This is a contract review, not product-test or implementation evidence.

- bounded-context-guardian: yes — existing capability boundaries, neutral persistence port, and one writer per transcript.
- input-contract-tests: yes — invalid/missing state, concurrent settlement, and persistence exceptions have binary acceptance; no new numeric public entry makes overflow applicable.
- error-handling-enforcer: yes — typed failures, bounded recovery, correctness-critical blocking, and separate best-effort trace semantics.
- complexity-anti-drift: yes — three capability slices with no prescribed monolithic implementation or duplicate authority.
- minimal-change-verifier: yes — one authorized checkpoint/recovery/trace contract; no new setting, dependency, export interface, or implementation in this documentation task.
