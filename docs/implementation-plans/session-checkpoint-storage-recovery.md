# Plan A: Session persistence, file recovery, and host entry

**Status:** Tasks 1-4 are implemented and merged — plan A commit `6f991fb7d`, merged into the integration baseline `60968adb4`. No task below is pending. Each task's status line names the single owner of whatever that task still leaves open (the repair / joined-acceptance round for issue #1182, its harness write-capture seam, or its session-host entry path), so no clause is owned by this plan and by a sibling plan at once.

**Goal:** A new-format persistent session saves recoverable native state and file-operation evidence, then safely reconciles an abnormal exit when reopened.

**Spec:** [Native session checkpoint architecture](../../specs/session-checkpoint-architecture.md).

**Decision:** [ADR-0136](../adr/0136-native-session-checkpoint-architecture.md).

**Approach:** Extend the existing session event/store and per-write snapshot mechanisms. The host coordinates publication and recovery; the harness supplies native runtime state through the spec's neutral persistence port.

## Parallel worktree contract

This is one of exactly three plans. Implement each in a separate session/worktree from the same documentation commit:

- **A, this plan:** session persistence, captured file effects, recovery orchestration, and persistent CLI/TUI/session host entry.
- **B:** [runtime, graph, and owned workers](session-checkpoint-runtime-workers.md).
- **C:** [final-request trace and readers](session-checkpoint-trace-evidence.md).

All three can begin in parallel. Shared source-file edits are allowed in separate worktrees; integration reconciles them. Responsibility boundaries describe behavior, not exclusive file locks. No fourth foundation plan or prior code-landing gate is required.

The following semantic contracts already come from the spec; choose concrete exported types and filenames during implementation, then reconcile them at integration:

| Boundary                           | Required behavior                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B to A: complete native state      | Supply the captured native message/context sequence, frozen session assembly/provenance, logical loop/graph/worker progress, root references, and terminal state. Exclude credentials, live handles, and process-memory grants. A persists and validates the body before publishing a checkpoint on the existing event/head chain. |
| B to A: operation facts            | Supply stable session/turn/tool/batch identities and protocol position. Record each independently settled result promptly; storage order is not model-message order. A acknowledges required persistence or returns a typed failure; B does not proceed with dependent execution on failure.                                       |
| A's file-capture boundary          | When capture is enabled, persist immutable pre/post bytes and every target's durable association before mutation. Existing explicit capture disable is represented as unavailable evidence, not a verified effect.                                                                                                                 |
| A and C: shared represented bodies | Reuse the session-local immutable pool; identical retained representations share a body. Native recovery data and trace-permitted redacted data retain separate authority and failure semantics. Preserve raw per-write `code-snapshots/`.                                                                                         |
| A to B: recovery                   | Load and validate the selected published native state, reconcile later persisted facts, and expose restored logical state. Reopening must not execute a model/tool/worker or reconstruct the saved context from transcript history.                                                                                                |

The event ID/parent/head chain remains the only branch/history authority. Do not create a second journal, independent current-checkpoint clock, timestamp selection rule, duplicate branch registry, or redundant file-restore anchor.

## Inherits and implementation boundaries

- The spec requires: “After a user message is accepted, persist its native context and publish the input checkpoint before dispatching the model call.”
- The spec requires: “A failed evidence write fails the dependent file operation before mutation.” This applies to enabled capture; the existing explicit `codeRestore.enabled` opt-out remains in force.
- The spec requires: “Recovery never issues model or tool calls.”
- ADR-0027 supplies append-only session history; ADR-0110 supplies one writer per transcript and assembly-level serialization.
- ADR-0121 and [code restore](../../specs/code-restore.md) retain explicit rewind safety, the live task-root identity, drift handling, prior-absence semantics, and independent worker transcript chronology.
- Existing session tmp is reread without extra snapshots. Old session data remains intact without migration or compatibility. No expiry, selective pruning, shadow workspace, filesystem watcher, new setting, or export interface is introduced.

Current code already has checkpoint markers, code snapshot bodies, and manual rewind. It does not yet supply this plan's durable native payload/operation association and automatic entry-recovery contract. Existing source/test files below are reuse evidence, not proof of the new behavior.

**Per-ticket loop:** TDD for behavior changes, followed by relevant typechecking and focused real-filesystem tests. Use a fresh temporary session/workspace and fresh conversation identity per case; never use a real user's session pool or repository `data/`. Tests may stub the external model or the other worktree's boundary, but must keep this plan's production store, writer, reader, and filesystem real. Local boundary evidence does not satisfy combined acceptance by itself.

## Architecture-change review

Inherited from the reviewed unified spec on 2026-10-03; this is pre-implementation review, not executed product evidence.

- bounded-context-guardian: yes — existing capability boundaries and neutral persistence port.
- input-contract-tests: yes — invalid/missing state, concurrent settlement, and persistence exceptions have binary acceptance.
- error-handling-enforcer: yes — typed failures, bounded recovery, and separate trace failure semantics.
- complexity-anti-drift: yes — capability slices preserve one responsibility and avoid duplicate authority.
- minimal-change-verifier: yes — one authorized contract, without new settings, dependencies, or export interfaces.

## Tasks (ordered by local dependency)

1. **Publish and reopen an accepted-input checkpoint** — tag: `[implementation]`
   - **Inherits:** “Only the published reference is selectable.” “Failure before publication leaves the prior checkpoint selected.”
   - **Surface:** `session-api` store and persistent CLI/session host; consume the neutral harness state port defined by the spec.
   - **Outcome:** An admitted new-turn input is fully saved before a controlled model boundary, and a new host restores its exact native state.
   - **Acceptance:** SC1, SC1a, SC2, and SC7. A real temporary store supports complete body-before-reference publication, positive new-format identification, selected-chain checkpoint lookup, and a fresh host load. Inject failures before/during publication: an incomplete trailing record cannot select unpublished state; missing/corrupt published bodies, middle-of-log corruption, invalid schemas, and unknown selected heads fail visibly without switching branch or rebuilding context. Invalid/empty references and duplicate publication do not invent progress. Produce one explicit event/anchor/state-reference mapping implementing the spec's field retrospective; convenience caches remain derived.
   - **Existing verification anchors:** `tests/session-api/store/session-store.test.ts`, `jsonl.test.ts`, `checkpoint.test.ts`, and `tests/cli/chat-session-checkpoint.test.ts`; run focused cases with `npx vitest run` and `npm run typecheck`. Extend coverage for the new boundaries; existing green tests alone are insufficient.
   - **Completion:** A reviewer can reopen the fixture through a fresh host and observe saved input with no model dispatch. The implementer can choose different helpers/record fields while preserving this behavior and existing branch authority.
   - Status: [x] implemented and merged (`6f991fb7d`, merged `60968adb4`) — real-store publication, chain-only selection, and the fresh-host load land with `tests/session-api/store/native-state.test.ts` and `tests/session-api/hub-input-checkpoint.test.ts`.
     - Open — owner: joined acceptance (#1182). The accepted-input write's durability across a real kill and its fresh-process reopen are a real-child-process proof, not a task-1 implementation gap; SC2's fixture half is still unrun.

2. **Persist every captured file intent before publishing a file** — tag: `[implementation]`
   - **Inherits:** “Persist both immutable bytes and the durable per-file operation association before touching the target.” “A multi-file call has a separate association for every target.”
   - **Surface:** `session-api` preimage/operation storage and the harness ACI write-tool capture port.
   - **Outcome:** Every enabled supported write has a durable per-file intent before its ordinary target is atomically replaced.
   - **Acceptance:** SC9, SC9a, and SC10. Use production capture with real files: evidence-write failure leaves the target unchanged; prior absence is distinct from an existing empty file; one multi-file tool retains all associations rather than last-write-wins. Stage ordinary content on the same filesystem, then publish per file. A controlled interruption before replacement shows wholly old bytes, and after replacement shows wholly new bytes. A published A and unstarted/interrupted B remain independently accountable. Preserve the existing capture-disabled behavior and show its evidence as unavailable; do not manufacture verification or change settings. Unsupported link/special-file or metadata cases must not silently inherit an atomic guarantee they do not satisfy.
   - **Existing verification anchors:** `tests/session-api/store/preimage-capture.test.ts`, `preimage-ledger.test.ts`, `session-store-preimage.test.ts`, `tests/harness/aci/tools/write-file-preimage.test.ts`, `edit-file-preimage.test.ts`, and `tests/harness/aci/symbol-mutate-preimage.test.ts`.
   - **Completion:** The fixture can kill a write between association and result persistence, then find every target's durable facts in a fresh store. The slice does not require a particular staging-helper or new file layout.
   - [blocks: A1]
   - Status: [x] implemented and merged (`6f991fb7d`, merged `60968adb4`) — the durable `file_intent` append, per-target atomic publish, and the unverified-effect report land with `tests/session-api/store/file-intent.test.ts`, `tests/session-api/hub-file-intent.test.ts`, and `tests/util/atomic-file-publish.test.ts`.
     - Open — owner: the harness write-capture seam. As of the merged baseline, the runtime port's per-file association (`RuntimeToolResultFact.files`, `src/shared/runtime-persistence.ts:138`) had no producer: the write tools append their `file_intent` through this plan's `NativeStatePort`, while the loop engine appends the `tool_result` fact without that field, so one write's two durable records were not joined.

3. **Recover settled facts and verified effects without replay** — tag: `[implementation]`
   - **Inherits:** “File agreement alone proves only that target's recorded effect; it never proves the entire operation succeeded.” “Manual code rewind remains a separate explicit action under ADR-0121.”
   - **Surface:** `session-api` checkpoint/operation reader, recovery orchestration, and existing code-preimage/root checks.
   - **Outcome:** A fresh host accounts for progress after its base checkpoint while preserving actual files and unknown outcomes.
   - **Acceptance:** SC4–SC5 at A's persistence boundary, SC11–SC14, and SC27. Persist an out-of-order settled result while an earlier tool remains blocked; reload its facts without confusing settlement order with context order. If actual bytes and captured live root match a saved postimage, retain that write even when the whole-tool result is absent. If bytes match the preimage, do not claim a verified replacement. Root mismatch, external drift, missing file bodies, or ambiguous same-path worker chronology yields `needs handling` with no workspace overwrite or fabricated tool success. Error results stay settled errors. Repeat recovery with fresh hosts: no duplicated receipts, results, checkpoint publication, file effects, or execution. Reread real session tmp without checkpointing it.
   - **Existing verification anchors:** `tests/session-api/store/code-preimage.test.ts`, `rewindable-preimages.test.ts`, `tests/session-api/hub-rewind-code-restore-live-taskroot.test.ts`, and `hub-rewind-worker-code-restore.test.ts`. Extend these or neighboring real-store tests to exercise recovery rather than equate it with rewind.
   - **Completion:** A deterministic partially completed multi-file fixture reopens twice with stable verifiable progress and unresolved-item reporting. No parent/worker total order or full-workspace snapshot is needed.
   - [blocks: A1, A2]
   - Status: [x] implemented and merged (`6f991fb7d`, merged `60968adb4`) — read-only reconciliation, the postimage/preimage agreement rules, needs-handling classification, and fail-closed `blocked` land with `tests/session-api/store/recovery.test.ts`, `recovery-reconcile.test.ts`, and `tests/session-api/store/native-state.test.ts`.
     - Open — owner: joined acceptance (#1182). Reopening the same fixture twice through real fresh hosts (no duplicated receipt, result, publication, or file effect) is a matrix item; the reconciliation itself is implemented and not pending.

4. **Wire visible session-entry recovery across persistent hosts** — tag: `[implementation]`
   - **Inherits:** “Recovery runs only for that selected session and displays a visible `recovery in progress` state.” “Any continuation is a later explicit operator action.”
   - **Surface:** persistent CLI chat, `session-api` Hub/serve, and their existing TUI/session view.
   - **Outcome:** Selecting a recoverable session loads state and displays recovery progress/result while leaving execution under explicit operator control.
   - **Acceptance:** SC2, SC6–SC8 in conjunction with B, SC17–SC18 at the host boundary, SC23, and SC27. Hosts invoke the same storage/recovery contract and restore the saved native state instead of only a transcript projection. Distinguish `recovered`, `needs handling`, and invalid/unsupported state. Old-format selection leaves old bytes unchanged and offers the existing new-session path. Do not restore process-local grants, auto-continue a goal/graph/worker, or declare an unknown worker dead. Record current root/config admission separately from saved historical evidence. Retained sessions do not expire by age/quota; preserve the existing explicit deletion boundary without adding a cleanup command.
   - **Existing verification anchors:** `tests/cli/chat-session-checkpoint.test.ts`, `tests/session-api/store/session-store.test.ts`, `tests/session-api/live-graph-hub.test.ts`, and existing TUI/session-host tests. Interactive validation later uses the available PTY tooling under normal permissions.
   - **Completion:** CLI chat and the Hub-backed session path each demonstrate saved input and visible recovery without a provider/tool call. B's genuine worker/graph state and C's trace are verified only after integration, not replaced with permanently mocked internals.
   - [blocks: A3]
   - Status: [x] implemented and merged (`6f991fb7d`, merged `60968adb4`) — one session-open path for hub/serve, CLI chat, and TUI, with entry classification and next-turn context from the published body, lands with `src/session-api/recovery-host.ts`, `tests/cli/chat-session-recovery.test.ts`, and `tests/tui/session-recovery-open.test.tsx`.
     - Open — owner: the session-host entry path (repair round #1182). As of the merged baseline `60968adb4`, two host-side hooks plan B could not own had no producer: `stopOwnedWorkers()` (`src/harness/subagent/manager.ts:1640`) was exported with no caller, so abnormal host exit did not stop owned workers, and `resumeTask` (same file, line 2811) still gated on the in-memory task map, so a task recovered in a fresh process refused with `not_found` instead of becoming continuable. The reopen sweep that presents `needs handling` is the same item. A repair round that lands any of these must correct this line rather than leave it as a standing claim.
     - Open — owner: the host-side runtime persistence adapter (repair round #1182). At the merged baseline no host bound the harness `RuntimePersistencePort` — `src/cli.ts`, `src/tui/deps.ts`, `src/cli/runtime.ts`, and `src/session-api/hub.ts` reference no `runtimePersistence` — so B's runtime/graph/worker facts had no persistence producer and no restore path, and the three state fields B names but cannot produce (`provenance`, skill-index seen state, logical continuation/mode state) had no host producer either. The adapter belongs behind the one contract in `src/shared/runtime-persistence.ts`, and `runtimeFacts` is the host bag that supplies the missing state (`src/cli/chat-session.ts:3003` is why it was empty).
     - Open — owner: joined acceptance (#1182). SC24's normal-permission persistent-host PTY interaction and SC18's reopen half are matrix items.

## Worktree handoff

Return the implementation commit(s), the concrete neutral port/schema choices, the exact event/head/checkpoint mapping, actual local check commands and results, and the injected crash points exercised. Identify any boundary fixture that still needs B or C's real component. Mention shared-file changes for merge coordination; their existence is not a reason to serialize the three worktrees.

These tasks were executed in `6f991fb7d` and merged in `60968adb4`; the handoff above is the contract that commit was held to, and the per-task status lines record what it returned. Commit count follows the project's logical-task policy, not one commit per bullet. A repair round runs code-review before landing; if it returns `GATE: BLOCKED`, repair the review report, then run verification-before-completion.

## One combined final acceptance after integration

The final integration session merges all three worktree changes, reconciles shared types/wiring and any source conflicts, and produces **one report** against every criterion in the unified spec. There is no fourth implementation plan or separate acceptance definition.

1. Use the real store/writer/readers and filesystem in fresh temporary sessions; cover all SC1–SC27, including SC1a and SC9a. Capture SC26's model-input applicability decision and required golden evidence or documented gap under the prompt guide.
2. Exercise the joined input-checkpoint → model request → eager tool progress → complete checkpoint → abnormal exit → selected-session reopen path. Use controlled barriers/crash points, not sleeps as a settlement oracle. Prove two successive reopens do not execute or duplicate effects.
3. Combine saved compaction/graph/worker progress with real session persistence; test a file published without a whole-tool result, original worker process identity/death, and current permission admission after recovery.
4. Verify C's exact SDK request oracle and trace-only represented-body reader against A's shared pool and B's invocation lifecycle. An isolated component stub is not joined-system proof.
5. Run `npm test`, relevant typechecks and the real PTY native-host path under ordinary permissions. Record every result and limitation; `eval-state` and `--yolo` are not acceptance evidence. Keep product implementation and its checks in the later implementation/integration sessions.

**Coverage:** A leads SC1, SC1a, SC2, SC7, SC9, SC9a, SC10–SC14, SC23, and SC27. B leads runtime/graph/worker criteria; C leads effective-input/reader criteria. SC2, SC6, SC8, SC11, SC18, SC21–SC22, and SC24–SC27 require the final joined evidence as applicable.

## Persist list

None. This plan inherits the unified spec and ADR-0136; it adds no domain term or one-way-door decision. A later implementation that changes those contracts must record the reason and return to the responsible design workflow rather than silently amend them.
