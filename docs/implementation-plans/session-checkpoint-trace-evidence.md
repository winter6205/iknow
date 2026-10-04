# Plan C: Final SDK-request evidence and trace-only reading

**Status:** Implemented and merged — plan C commit `5b6b753e4`, merged into the integration baseline `60968adb4`. All four tasks below are done at the plan-C layer; the joined 29-criterion matrix has not been run, so no acceptance result is claimed here.

**Goal:** Retain the exact represented inputs of every governed SDK invocation and read those inputs through the existing trace surface without exposing native recovery content.

**Spec:** [Native session checkpoint architecture](../../specs/session-checkpoint-architecture.md).

**Decision:** [ADR-0136](../adr/0136-native-session-checkpoint-architecture.md).

**Approach:** Extend the final model-adapter dispatch boundary, existing masked immutable body writer, and existing reference reader. Keep per-invocation identity separate from reused content identity.

## Parallel worktree contract

This is one of exactly three plans, alongside [A: storage and host recovery](session-checkpoint-storage-recovery.md) and [B: runtime and owned workers](session-checkpoint-runtime-workers.md). Start all three in separate sessions/worktrees from the same documentation commit. Shared source files may change in multiple worktrees; reconcile physical type names and wiring at integration. There is no fourth foundation plan or prerequisite code landing.

A owns required native-state persistence and host recovery. B owns logical runtime progress and invocation lifecycle. C owns actual-request evidence, trace health, and trace-permitted reading. All consume the unified spec's behavioral persistence/body contract; temporary boundary fixtures do not authorize a competing store, branch registry, or history.

The session-local immutable pool may share identical retained representations. Raw native state and masked trace representations retain separate reader authority and failure semantics; raw file pre/postimages stay in `code-snapshots/`. Trace readers follow only references authorized for the selected trace, even when other bodies physically coexist in the pool. A's required persistence failures block dependent execution; C's trace failures remain best-effort and must never cause another SDK invocation.

## Inherits and implementation boundaries

- The spec requires: “Capture the exact request object passed at model-provider/SDK dispatch, after all effective-message injections, compaction projection, instruction-authority projection, and tool-definition projection have been applied.”
- The spec requires: “Each governed SDK invocation has its own call identity even when its request bodies reuse existing immutable references.”
- The spec requires: “Apply existing masking/redaction before content addressing.”
- The spec requires: “Independent reading uses the trace JSONL plus exactly its referenced trace-permitted bodies in the existing relative layout.”
- ADR-0136 scopes the content-trace change for new-format persistent native sessions. ADR-0036 and the unaffected ADR-0003/0035/0071 clauses retain masking, trace-health, lifecycle, and transport boundaries. ADR-0116 stays deprecated.

Existing trace bodies/readers are reuse points. Existing pre-projection engine messages are not an oracle for the final SDK request. No new export command/UI, whole-session bundle, expiry, quota collector, cross-session deduplication, settings change, or transcript reconstruction is included.

**Per-ticket loop:** TDD for behavior changes, then relevant typechecks and focused Vitest tests. Use fresh temporary session directories and the production adapter projection, body writer, masker, and reader. Stub the external SDK/provider boundary and, where needed, another worktree's port; do not replace this plan's production writer/reader with mock internal methods. Local fixtures must record what remains for joined-system acceptance.

## Architecture-change review

Inherited from the reviewed unified spec on 2026-10-03; these are pre-implementation verdicts, not executed product evidence.

- bounded-context-guardian: yes — adapter evidence and trace reading stay within existing capability boundaries and neutral body ports.
- input-contract-tests: yes — missing/invalid references, concurrent attempts, and persistence/SDK exceptions have binary criteria.
- error-handling-enforcer: yes — non-throwing trace health is separate from mandatory native-state persistence.
- complexity-anti-drift: yes — capture, represented-body storage, and reading have distinct responsibilities without another journal.
- minimal-change-verifier: yes — existing trace surfaces and redaction are reused; no new settings, dependencies, or export interface.

## Tasks (ordered by local dependency)

1. **Retain immutable trace-permitted representations** — tag: `[implementation]`
   - **Inherits:** “Identical represented bodies within the session reuse one immutable body; changed bodies receive new content; a digest without a retained body is not a valid reference.”
   - **Surface:** Existing `src/harness/trace/jsonl.ts`, trace types, masker, and the shared session-local represented-body boundary used by A. Physical helpers may be reconciled after merge.
   - **Outcome:** Trace references address complete retained masked content with representation/consumer authority, rather than raw native state or hashes alone.
   - **Acceptance:** SC20 and C's SC21 contribution. With real temporary files, mask before hashing/storage; identical retained bytes reuse a body, changed bytes produce a different reference, and differently transformed/raw bodies cannot be substituted by a reader. Mark transformed, unavailable, and failed-to-capture evidence distinctly. Inject immutable-body/JSONL failures and observe non-throwing trace health, with no inline fallback claiming complete evidence. Do not turn trace failure into mandatory native-state failure or weaken A's mandatory writes.
   - **Existing verification anchors:** `tests/harness/loop-trace.test.ts`, `tests/session-api/hub-trace-evidence.test.ts`, and existing trace writer tests. Extend neighboring tests for represented bodies rather than merely asserting a hash is present.
   - **Completion:** The fixture dereferences the retained representation and compares its full content with the existing masker output. Record representation and access choices for integration with A.
   - Status: [x] done — committed as `5b6b753e4` and merged in `60968adb4`; representation, address-gate, and reader choices recorded in the local-only `docs/handoff/2026-10-03-session-checkpoint-plan-c-trace-evidence.md` (`docs/handoff/` is gitignored, so the durable record is this plan's closing section), including the blocking non-trace tag requirement on Plan A.

2. **Capture each exact final SDK invocation** — tag: `[implementation]`
   - **Inherits:** “The captured record must identify the exact ordered messages, actual system instructions, and complete tool definitions supplied in that dispatch object.” “A trace capture or storage failure must not dispatch the request again.”
   - **Surface:** `src/harness/model-adapter/anthropic-adapter.ts`, `outbound-projection.ts`, adapter/trace types, and invocation-lifecycle wiring from `src/harness/loop-engine.ts` as needed. B's logical progress and A's required input checkpoint remain their responsibilities.
   - **Outcome:** Streaming and non-streaming attempted requests retain exact final input evidence and distinct invocation identity, including SDK rejection and streaming failure.
   - **Acceptance:** SC19 and SC21. A deterministic external SDK stub receives the final request parameter object after all projection; dereferenced unmasked evidence equals its ordered messages, system instructions, and full advertised tools. Test injected status context, compaction context, and tool/instruction projection. Two dispatches sharing bodies have distinct call identities. SDK rejection or stream failure remains attached to the original attempted invocation. Successful SDK dispatch occurs exactly once despite trace failure; do not retry a model call because evidence storage failed. Existing transport retries remain separately governed and each additional actual invocation has its own evidence. Never capture credentials/transport headers or claim provider receipt.
   - **Existing verification anchors:** `tests/harness/adapter-wire-model.test.ts`, `tests/harness/loop-trace.test.ts`, and neighboring model-adapter/transport tests. The expected object is recorded by the SDK stub; do not generate the oracle from the trace implementation or earlier engine state.
   - **Completion:** Both dispatch modes and failure paths pass the independent final-request oracle. The trace still distinguishes an attempted call from a successful response.
   - [blocks: C1]
   - Status: [x] done — committed as `5b6b753e4` and merged in `60968adb4`; `tests/harness/model-adapter/dispatch-evidence.test.ts` and `tests/harness/trace/dispatch-evidence-outcome.test.ts` pass, and a real-model end-to-end check deep-equalled the captured wire body. Re-run after merge.

3. **Preserve trace-only reference reading and portable copies** — tag: `[implementation]`
   - **Inherits:** “The existing trace reader follows references belonging to the selected trace.” “It must not expose native recovery bodies or enumerate/export every body merely because the physical pool is shared.”
   - **Surface:** `src/traceserver/project-tool-results.ts`, `reader.ts`, existing query/get-record/read-side whitelist, and trace types.
   - **Outcome:** Existing readers dereference the full final-request evidence while access remains limited to trace-permitted references.
   - **Acceptance:** SC22. Use the production reader against a real shared-pool fixture containing unrelated raw checkpoint bodies and masked trace bodies. Referenced permitted bodies remain readable; attempts to reach raw native content or broadly enumerate the pool fail under the trace access contract. Copy trace JSONL alone to a fresh directory and report incomplete/missing evidence; copy it plus only its trace-permitted referenced bodies in the existing relative layout and reproduce the same readable view. Preserve existing query/get-record semantics; add no export endpoint, CLI command, UI, or raw-pool bundle.
   - **Existing verification anchors:** `tests/traceserver/reader.test.ts`, `get-record-core.test.ts`, `read-side-whitelist.test.ts`, `full-mode-baseline.test.ts`, and `tests/session-api/trace-mounted.test.ts`.
   - **Completion:** A copied trace's readable evidence is sufficient without the native recovery pool, and trace queries cannot retrieve that pool's raw contents.
   - [blocks: C1] [parallel]
   - Status: [x] done — trace addresses complete retained masked content, and the trace reader dereferences the full final-request evidence through one shared address gate. The anti-coupling regression R2 surfaced in `tests/traceserver/t3-trace-dir-derivation.test.ts` was fixed by giving its injected-port fixture a legal 64-hex body address; the whole-message, content-level, and evidence ref shapes are now judged by the same rule.

4. **Close evidence gaps and prepare combined acceptance** — tag: `[implementation]`
   - **Inherits:** “A trace writer/body failure is reported by existing trace-health semantics and does not fail the model call; a native-state write failure blocks dependent recovery-critical execution.”
   - **Surface:** Adapter/writer/reader integration, existing trace-health propagation, and model-input applicability review under [the prompt guide](../guides/prompt-development.md).
   - **Outcome:** The implementation reports exact local evidence and leaves no confusion between observational trace failures and required recovery persistence failures.
   - **Acceptance:** SC19–SC22 and SC26 locally; SC21 with A's real persistence after integration. Inject each trace failure before/after dispatch and verify call counts, failed-attempt identity when the sink remains available, and explicit evidence gaps when it does not. Check that trace health reaches the existing operator surface. Review the diff for model-visible text changes: if present, use the existing golden roster and required acceptance under the prompt guide; otherwise record that model-input text is unchanged. Do not create a new golden set merely for observational recording, or use `eval-state`/`--yolo` as evidence.
   - **Existing verification anchors:** Focused adapter/trace/reader tests above, relevant `npm run typecheck` and `npm run typecheck:tests`; golden tests only as required by the model-visible change assessment.
   - **Completion:** The handoff includes actual commands/results, independent oracle evidence, injected failure points, chosen physical reference fields, and any cross-worktree fixture awaiting real joined components.
   - [blocks: C2, C3]
   - Status: [x] done — actual commands and results, the independent wire-level oracle, injected failure points, and the chosen physical reference fields are recorded. SC26, corrected after the merge: plan C's own diff changes no model input (no tool description, schema, or system-prefix text; trace bodies are operator-side), but the joined plans A/B/C diff does — plan B's per-node durability added two `undurable` node-failure sentences in `src/harness/graph/run-graph-tool.ts`, delivered to the model as a node's `error` field. They now carry a STATIC lock (`tests/harness/graph/graph-undurable-text.test.ts`) and the graph row of `docs/guides/prompt-development.md` registers their trajectory gap. SC21 against A's real persistence stays an integration-session check, as does the joined 29-criterion matrix below.

## Worktree handoff and one combined acceptance

Return implementation commit(s), concrete adapter/port/reference choices, actual verification results, and merge coordination notes. Shared-file edits are allowed. These tasks were executed in `5b6b753e4` and merged in `60968adb4`; the handoff above is the contract that commit was held to. A repair round runs code-review before landing, repairs any blocked findings, then runs verification-before-completion; commit count follows the project's logical-task policy.

C leads SC19–SC22 and contributes SC26. Its local tests do not prove A/B's runtime or the joined system. After merging all three worktrees, one final integration session follows the unified spec's **entire 29-criterion matrix: SC1–SC27, SC1a, and SC9a**. SC25 is the report requirement, including evidence for the other criteria. There is no fourth plan or alternative acceptance definition.

Use the real A/B/C store, writer, reader, filesystem, graph, and worker boundaries. Join accepted input → actual SDK invocation → eager settled facts → full checkpoint → abnormal host termination → selected-session recovery, and reopen twice without duplicate execution/effects. Verify C's trace-only reader against A's shared pool and B's actual invocation lifecycle. Run the complete `npm test` product path, relevant typechecks, and SC24's normal-permission persistent native host PTY interaction. Record SC26's model-input applicability and any required golden evidence. Product implementation, process-crash tests, and PTY acceptance belong to those later sessions; no current success is claimed.

## Persist list

None. This plan inherits the unified spec and accepted ADR-0136 without adding a term or architectural decision. Implementation details may vary while preserving the exact-request, immutable-content, reader-authority, and failure contracts.

## Integration constraints this implementation fixed (tracked here because `docs/handoff/` is gitignored)

`docs/handoff/` is gitignored (`.gitignore:232`), so the operator-facing handoff is local-only. The following are therefore recorded here, where the sibling plans and the joined integration session will actually see them.

**Physical choices now fixed by C.** The session-local immutable body pool is `<session-dir>/blobs/<sha256>`, one file per distinct masked body, named by the constant `BLOBS_DIR_NAME` (`src/shared/session-tree-names.ts`). The representation tag is `TRACE_BODY_REPRESENTATION = "masked-trace-v1"`, declared in `src/shared/trace-body-contract.ts` — the neutral layer, not `src/harness/`, because `src/traceserver/**` must not import `src/harness/**` (`tests/traceserver/output-backstop.test.ts:87`). The `llm_call` row key is `dispatch_evidence`; each entry is `{ invocationId, stream, messages, system?, tools?, outcome }` with each body a `{ sha, bytes, representation }` ref. Note that an entry's `messages` is the whole serialized post-projection request body, distinct from the row's pre-existing `messages` field, which is the engine's pre-projection state — that distinction is the point of the feature. The reader gained `final_request_evidence` (manifest arm only) and `evidence_gap: "unreadable_referenced_body"`.

**Blocking requirement on Plan A.** ADR-0136 Decision 7 places raw native checkpoint bodies and masked trace bodies in the _same_ physical pool. C's reader accepts an untagged ref for back-compat — the untagged shape is what the message-content writer emits and what every legacy fixture holds, and requiring the tag would make existing traces unreadable. That dual acceptance means the **address gate confines every read, not the tag**: `blobs/` is the only directory a trace ref can reach, and a 64-hex-lowercase address cannot leave it. So Plan A **must** stamp its native bodies with a non-trace representation tag. If A writes untagged native bodies into `blobs/`, this reader cannot discriminate them and a trace ref could resolve to native content. This is the one cross-plan dependency C introduces, and it is the reason the uniform address gate matters.
