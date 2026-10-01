# Spec: Hard-wall denial alignment (#1170)

**Status:** Specified; architecture review passed; implementation not started  
**Basis:** GitHub issue #1170; wayfinder map `hard-wall-denial-alignment`; ADR-0068, ADR-0091, ADR-0092, ADR-0108, ADR-0123 through ADR-0129, ADR-0130 through ADR-0135.  
**Review state:** The operator confirmed the policy and interface assumptions. Architecture review passed all five dimensions on 2026-09-30; this is not an implementation plan.  
**Verification state:** The matrix below is proposed evidence. No tests, benchmark reruns, or implementation changes were performed for this draft.

## Objective

Correct the hard-wall false denials reported by issue #1170 while preserving non-overridable protection for confirmed sensitive or destructive intent. Make policy admission and Bash execution use the same classification, scope scratch cleanup to the calling identity, and let ordinary workspace cleanup and read-only root searches reach the existing permission and execution controls.

For finite Bash execution, use a 10-second default and let the model provide this invocation's runtime timeout. Keep foreground calls blocking until completion or timeout. Enforce an actual deadline for finite background jobs without resetting it during polling, and report process cleanup truthfully. For `background: true`, an explicit `timeout_ms` selects a finite job; omission preserves the existing persistent-service lifecycle.

When repeated, confirmed security violations occur in one turn, stop that turn and its owned work while retaining the session. Preserve raw benchmark outcomes and add evidence-based failure attribution so a harness denial is not mistaken for model inability.

## Boundaries

- **Does:**
  - Refine sensitive-path intent classification into confirmed access/modification, proven non-path content, and unresolved security-relevant content.
  - Allow bounded non-recursive explicit-file `rm -f` cleanup under the current identity's session scratch, and ordinary workspace file deletion through the existing mode-based permission flow.
  - Remove the blanket hard-wall denial for read-only `find /` searches. Keep mutating root searches and other destructive operations denied under their existing rules.
  - Define the Bash foreground timeout input, default, execution behavior, and bounded process-tree cleanup result.
  - Preserve the explicit foreground/background interface. Define finite background deadlines through explicit `timeout_ms`; omission preserves the existing persistent-service lifecycle.
  - Apply the current-turn security escalation contract and record enough trace evidence to support later benchmark attribution.
  - Correct the `malformed` diagnostic while preserving its hard denial and updating its golden expectations.
- **Confirms with human:**
  - No unresolved policy choice remains. Changes to these accepted boundaries or to deferred evaluation-tooling scope require renewed alignment before implementation.
- **Out of this spec:**
  - Replacing the shell parser, changing ADR-0124 parse-state destinations, changing ADR-0127 review semantics, or redesigning the interpreter-independent effect boundary.
  - Global file-creator provenance tracking, a new scratch store, a new automatic foreground-to-background transition, or a new persistent-service heuristic.
  - Changes to non-Bash ACI timeout tiers, a new fixed runtime ceiling, or a root-search-specific 30-second cap. Docker image preparation/cache optimization belongs to the evaluation-tooling follow-up (#1167).
  - Changes to model capability conclusions or task/turn budgets owned by #1169; benchmark reruns and implementation are downstream work.

## Assumptions and accepted decisions

Each item below records a choice accepted during the issue #1170 design discussion on 2026-09-30. The background timeout omission and violation-counter reset contracts were separately confirmed in the final specification discussion.

1. **Sensitive-path evidence:** A fragment hit is a candidate, not a verdict. Confirmed sensitive-path access or modification intent is a non-overridable hard deny; proven non-path code or inert data creates no finding from this wall and proceeds through ordinary permissions; unresolved security-relevant content requires a fresh ADR-0127 Security review, or a typed deny if no interactive route is available. Keep the current fragment roster and end-of-command anchors. Preserve ADR-0124 non-`ok` routes and recursively deny confirmed nested shell access. ADR-0131 records this decision.
2. **Identity scratch:** Each main-session or worker identity may clean up only finite, explicit files inside its own existing host-backed session scratch, using non-recursive `rm -f`. Every target must be established inside that root using filesystem-aware containment and a trusted per-call root snapshot shared by admission and execution. Do not authorize the scratch root itself, recursive deletion, mixed/outside targets, another identity's scratch, reads, or protected targets. ADR-0132 records this decision.
3. **Workspace cleanup:** Non-recursive explicit-file deletion of an ordinary file inside the active `taskRoot` (including an existing user file) passes this hard-wall check into ordinary permissions; it does not require a global creator ledger. A filename such as `tmp_*` is not proof of provenance or authority. `default` continues to ask under the existing ordinary Bash permission policy; `full_auto` may allow ordinary workspace mutation. Protected targets and other hard walls remain non-overridable.
4. **Root search:** A read-only search rooted at `/` is not denied solely because of its root. It proceeds through ordinary permission checks and the common Bash execution timeout. A root search with mutation such as `-delete` does not inherit this allowance. Root search has no separate 30-second limit.
5. **Bash execution time:** A finite foreground Bash invocation defaults to 10 seconds. An optional model-supplied positive integer `timeout_ms` controls that invocation and replaces the legacy static Bash build timeout rather than being nested beneath it. Zero, negative, non-integer, non-finite, or unrepresentable/overflowing values fail before process launch; they are never silently clamped. There is no additional fixed 300-second ceiling or command-specific runtime cap. Other ACI tools' timeout contracts are unchanged.
6. **Execution mode:** Foreground stays blocking until the command completes or its execution deadline expires. Explicit background launch stays explicit and returns its existing task handle; no automatic yield or foreground-to-background conversion is added. A finite background task's deadline is measured from launch and continues after the handler returns; polling does not restart or extend it. For `background: true`, a supplied valid `timeout_ms` establishes that finite deadline; omission selects the existing persistent-service lifecycle without a runtime deadline.
7. **Process cleanup:** Reuse bounded TERM/grace/KILL teardown. Keep escalation active while descendants remain, even if the leader exits. Wait only for a bounded period for process-group disappearance and retain the observed boolean. Return “stopped” only when exit is confirmed; otherwise report cleanup unconfirmed. A background stop request is distinct from confirmed task exit. Never let cleanup wait hang the harness indefinitely.
8. **Violation escalation:** Three consecutive confirmed security violations in the current turn stop that turn, retain the session, and cancel further model requests/tool scheduling plus in-flight tools and this turn's owned workers/finite background jobs, followed by bounded cleanup. Repeated hits of the same rule count; there is no cross-turn lifetime accumulator or same-rule de-duplication. Routine permission denials, reviewer unavailability, timeouts, and cleanup failures are not confirmed security violations. Existing high-severity immediate handling remains. An admitted and successfully executed tool call resets the streak. Routine denials, review unavailability, timeouts, cleanup failures, and other unsuccessful non-violation calls neither increment nor reset it. Each new user turn starts at zero.
9. **Evaluation evidence:** Keep benchmark task pass/fail outcomes unchanged and report attribution separately. A deny alone does not prove harness causation. Use the existing trace mechanism plus grader/verifier and task-result evidence; trace records facts and does not decide attribution automatically. Compare before/after with the same model, task/dataset version, mode, and task budget, and repeat stochastic trials. Timeouts and turn caps alone do not prove a model capability failure.
10. **Scope of evidence:** The evaluation entry and the normal `ask`/Serve routes that use the shared JSONL trace service are in scope for trace conformance. Plain CLI `chat` does not currently wire the content trace service; this spec makes no existing-parity claim for that entry. The current evaluation entry is foreground Bash only, so background parity is not claimed here.

## Architecture contracts

### Permission classification

- The permission wall and the Bash handler consume one shared classification result for destructive-command and sensitive-path admission. The handler must not independently reclassify the command with a broader rule that contradicts permission admission.
- Preserve the sensitive-fragment inventory and anchor behavior. Keep actual redirect targets, established path operands, and recursively parsed nested shell access eligible for a confirmed-path verdict. A string such as `process.env.NODE_OPTIONS` in code is not by itself evidence of a filesystem path.
- If security-relevant target or ownership evidence remains unresolved, invoke the existing fresh per-call Security review before grants or mode-based permission. If the route is absent or unavailable, return the existing typed-deny form. Do not turn reviewer unavailability into a confirmed violation.
- Keep `malformed` as a hard denial. Correct its user-facing diagnostic and pin the updated expected message.

### Cleanup and root traversal

- Scratch cleanup consumes a trusted identity-specific host snapshot before both policy admission and Bash handling. Lexical prefix checks alone do not establish containment. Any target that is unresolved or escapes containment receives no scratch exception and follows existing review/deny rules.
- Workspace cleanup is eligible for ordinary permission handling only when every operand is a finite explicit file target within the active `taskRoot`, after path resolution against the command's effective working directory. Mixed targets, recursive forms, globs that do not resolve to a bounded explicit target set, protected targets, and paths outside the task root do not receive this allowance.
- The root-find exception covers only read-only traversal intent. It does not authorize `-delete`, `-exec`, or other mutating/effectful forms by virtue of being a search. Remaining permissions, protected-target checks, and sandbox controls still apply.

### Runtime deadline and cleanup

- The foreground Bash timeout is a runtime deadline, not merely a frontend wait duration. If omitted, use 10 seconds; if supplied, use the validated model value for that run. Do not add a root-find-only limit or silently clamp a valid supplied runtime to the former build tier.
- The input is optional `timeout_ms`, in milliseconds. Accept only positive finite integers whose deadline and host timer can be represented without overflow; reject zero, negative, fractional, non-finite, or unrepresentable values with a typed input failure before launch. Representation limits are not a command-category runtime policy and must not silently shorten an accepted timeout.
- A finite background task has one deadline established at launch. Handler return, polling, reading logs, and stop requests do not extend it. A still-running task is terminated when that deadline expires. For `background: true`, a supplied `timeout_ms` selects this finite behavior; omission preserves the existing service lifecycle. Do not infer lifecycle from command text or add a new flag.
- Process cancellation must reach the process group using the existing TERM/grace/KILL route. The teardown result must distinguish confirmed group disappearance from a bounded wait that ended while descendants remained. Both foreground timeout and background stop must expose this distinction.
- Timeout, a routine permission denial, review unavailability, and unconfirmed cleanup do not increment the security-violation threshold. A timeout remains the per-call tool outcome described by ADR-0091; it does not by itself become a loop `StopReason`.

### Failure and concurrency contract

- Invalid `timeout_ms` is a typed input-validation failure before launch, carried through the existing ACI failure envelope with the tool-use ID. Implementation must define a named validation-error variant; callers must not recognize it by matching an arbitrary message substring. No process, background registry entry, or execution timer is created for invalid input.
- Deadline expiry preserves the existing `execution_failed` / `message: "timeout"` contract; outer cancellation preserves `message: "cancelled"`. Supplement these outcomes with structured cleanup evidence rather than replacing them with a new loop stop reason.
- Cleanup evidence is a discriminated result: `not_started`, `confirmed_stopped`, or `unconfirmed`. `unconfirmed` carries the task/process identity and a typed reason for observation expiry or teardown failure. It is not a successful stop. A TERM/KILL or observation exception cannot be swallowed or converted into `confirmed_stopped`.
- The exit condition for bounded cleanup is confirmed disappearance or expiry/failure of the bounded observation. On the latter route, return `unconfirmed` and retain diagnostics through the existing result/trace surfaces. Downstream code must document that exit condition at any fallback branch; it must not substitute an empty catch, null result, or success default.
- Concurrent calls own independent validated deadlines, abort listeners, cleanup state, and tool-use IDs. They share only the host's applicable batch/root snapshot under the existing root contract. One call's timeout or stop must not cancel an unrelated call or task; a turn-level safety interruption cancels only work owned by that turn. Competing timeout, caller-cancel, process-exit, and explicit-stop events yield one terminal task transition with preserved cause and cleanup evidence.

### Turn interruption and evidence

- On the third consecutive confirmed violation, stop new model/tool work immediately, abort in-flight work owned by this turn, cancel this-turn workers and finite background jobs, and collect bounded cleanup results. Retain the conversation and persist/report a typed interruption and cleanup state using the existing turn outcome and closeout contracts. Do not terminate the whole session.
- Use the existing `cancelled` turn outcome with structured security-interruption cause and cleanup confirmation state; preserve the closed `StopReason` set and the existing in-flight closeout contract. This is distinct from an ordinary per-call timeout. Reset the current-turn streak only after an admitted tool call finishes successfully. Unsuccessful non-violation outcomes are neutral; a new user turn resets the count to zero.
- Use the existing content JSONL trace service for raw runtime evidence; do not treat `LoopTrace` as a payload trace or create a parallel authoritative transcript. The trace must let a reviewer correlate the policy result, tool result, timeout/cancel outcome, process cleanup confirmation, and task/grader outcome where those events exist. No automatic attribution verdict is required.
- Keep raw benchmark results and add a separate per-task attribution label:
  1. **Harness-induced block:** causal evidence shows a false denial or runtime/cleanup fault prevented task completion.
  2. **Model or policy outcome:** evidence shows model noncompletion/wrong answer, or a real confirmed security violation.
  3. **Unknown or mixed:** evidence is insufficient, conflicting, or points to evaluator/environment effects that cannot be separated confidently.
- Attribution is supplementary to the benchmark's original score. Do not drop harness-blocked failures from the raw total or present the attributed subset as the full benchmark score.

## Affected modules

These are the expected implementation surfaces; the architecture review may refine ownership without changing the contracts above.

- `src/harness/permission/hard-walls.ts`, `src/harness/permission/policy.ts`, and `src/harness/aci/permission.ts` — shared sensitive/destructive intent classification, root-find and cleanup admission.
- `src/harness/aci/tools/bash.ts` and the Bash input/executor path — handler parity, model timeout input, foreground deadline and background launch contract.
- `src/harness/sandbox/fence-tmp.ts` and permission context construction — identity scratch snapshot and active task-root context.
- `src/harness/aci/aci-executor.ts`, `src/harness/sandbox/runner.ts`, and `src/harness/sandbox/server/` — runtime deadline, process-group escalation, bounded cleanup result.
- `src/harness/background/manager.ts` — finite background deadline enforcement and stop-confirmation state; explicit timeout omission preserves persistent services.
- `src/harness/sandbox/violation-handling.ts`, `src/harness/sandbox/violation-executor.ts`, and the CLI/Serve turn assembly — per-turn counting, immediate scheduling stop, owned-work cancellation, and retained-session outcome.
- `src/harness/trace/jsonl.ts`, normal `ask`/Serve trace assembly, and `scripts/harbor/iknow_harbor/agent.py` — structured raw evidence and trace enablement for evaluated trials.
- Existing hard-wall, Bash, runner, background-manager, violation, trace, and Harbor adapter test suites; the exact tests and any additions are proposed in the verification matrix, not run here.

## Success Criteria

Each criterion is binary. All verification below is proposed and has not been executed.

1. **Sensitive-path false-positive correction:** `node -e 'process.env.NODE_OPTIONS'` produces no sensitive-path wall finding and proceeds through ordinary permission handling, while confirmed sensitive reads/writes, redirect targets, and recursively executed nested-shell paths remain non-overridable hard denies in both `default` and `full_auto`.
2. **Sensitive uncertainty and parser contract:** proven inert examples do not trigger review; unresolved security-relevant examples require fresh per-call review or typed denial when unavailable; every ADR-0124 non-`ok` case keeps its current destination. A differential report lists every changed deny and contains no unexplained security-relevant `deny → allow` row.
3. **Shared admission/handler verdict:** policy admission and Bash handler return the same sensitive/destructive classification for each matrix case, including the three evidence classes and nested commands. No permission-admitted command is later rejected by an unshared broader duplicate of the same wall.
4. **Identity scratch cleanup:** explicit non-recursive `rm -f` of a file inside the calling identity's scratch reaches ordinary permissions; the equivalent trusted absolute path and `$TMPDIR` form behave consistently. Root deletion, recursive deletion, another identity, mixed/outside targets, unresolved containment, and protected targets receive no scratch allowance.
5. **Workspace cleanup:** `rm -f tmp_pycheck.cjs` for a resolved ordinary file in `taskRoot` has no destructive-rm hard-wall finding and reaches ordinary permissions (`default` asks; `full_auto` may allow). An existing user-created file receives the same path-policy result without creator tracking. Recursive, unresolved, mixed, outside-root, and protected targets remain denied or reviewed by their owning existing rule.
6. **Root read-only search:** representative read-only `find /` commands, with and without `-maxdepth`, are not denied solely for a root walk and reach ordinary permission plus the common Bash timeout. Root mutation (including `find / -delete`) remains denied. No special 30-second root-search cap is present.
7. **Foreground Bash timeout:** an omitted model timeout yields a 10-second Bash runtime deadline. A valid positive integer `timeout_ms` replaces the default and is not clipped by a second fixed 300-second build cap. Zero, negative, non-integer, non-finite, or overflowing values fail before process launch and are not converted into a short accidental timer. Other ACI tool timeout behavior is unchanged.
8. **Foreground lifecycle:** a foreground command remains blocking until it exits or its runtime deadline expires; timeout invokes bounded TERM/grace/KILL cleanup. There is no automatic foreground-to-background conversion.
9. **Finite background lifecycle:** for a task classified as finite, the launch-time deadline remains unchanged after handler return and through repeated polls; expiry stops the process, and polling cannot reset the clock. A task not confirmed stopped within the bounded cleanup window returns cleanup-unconfirmed. A background launch without `timeout_ms` retains the existing service lifecycle and is not killed by the foreground 10-second default.
10. **Truthful process cleanup:** a fixture where the leader exits but a descendant remains keeps escalation active; the result reports confirmed stopped only after the process group is observed gone. A bounded wait with a surviving group reports unconfirmed and never hangs indefinitely.
11. **Current-turn escalation:** three consecutive confirmed security violations in one turn stop subsequent model requests/tool scheduling, cancel in-flight turn-owned work and finite background jobs, perform bounded cleanup, and retain the session with a typed interruption result. Same-rule repeats count; counts do not leak across user turns. Routine denials, reviewer failures, timeouts, and cleanup failures do not count. An admitted successful call resets the count; excluded failure classes leave it unchanged; a new user turn starts at zero.
12. **Trace evidence:** enabled normal `ask`/Serve and evaluation traces use the shared JSONL service/schema and can correlate permission, command completion/timeout, cleanup confirmation, and evaluation task/grader outcomes without an automatic verdict. The specification does not claim plain CLI `chat` parity or evaluation background execution.
13. **Benchmark attribution:** every trial preserves its original pass/fail result and receives exactly one supplementary attribution label from the three-category contract, with evidence references. A deny without causal evidence is not labeled harness-induced; timeout or turn cap alone is not labeled model failure. Before/after comparisons pin the same model, benchmark/task version, permission mode, and task budget and include repeated trials.
14. **Diagnostic correction:** the `malformed` case remains a hard deny, its diagnostic accurately names the malformed input, and the relevant golden expectation is updated to the exact revised message.

## Proposed verification matrix (not executed)

| Area | Proposed evidence | Pass condition |
|---|---|---|
| Sensitive matching | Table-driven unit and differential cases for confirmed path intent, inert code/data, unresolved ownership, redirects, nested shells, roster anchors, and every ADR-0124 non-`ok` route | Criteria 1–3 hold; no unexplained security-relevant relaxation |
| Scratch and workspace cleanup | Permission + handler integration cases for own/other identity, trusted variable/absolute/relative paths, mixed operands, recursive forms, symlink/uncertain containment, protected targets, default/full_auto, and an existing user file | Criteria 4–5 hold with the same classification at both gates |
| Root search | Rooted read-only `find` cases with depth variations and mutating/effectful counterexamples | Criterion 6 holds with no root-specific timeout cap |
| Runtime timeout | Foreground no-override/override/invalid/overflow cases and an execution that exceeds the selected deadline | Criteria 7–8 hold; process result distinguishes timeout and cleanup state |
| Input concurrency and exceptions | Concurrent Bash calls with different deadlines; empty/wrong-type/zero/fractional timeout inputs; spawn failure; TERM/KILL/observation exceptions; simultaneous timeout/cancel/stop/exit | Invalid inputs launch nothing; one call cannot affect another; each task has one terminal transition; exceptions remain typed and cannot produce confirmed-stop evidence |
| Process tree and background | Controlled child/grandchild process cases, poll past deadline, and stop while leader/descendant states differ | Criteria 9–10 hold; no test depends on wall-clock timing beyond bounded tolerances |
| Escalation | Turn-level sequences for repeated same/different confirmed violations, routine denials, review unavailable, timeout, cleanup failure, and the selected reset cases | Criterion 11 holds for the accepted successful-call-only reset rule |
| Trace and evaluation | Parse emitted JSONL from the actual evaluation entry and normal `ask`/Serve; join it to grader/task results; retain raw trial outcomes | Criteria 12–13 hold; classification includes evidence and does not alter raw score |
| Diagnostic | Golden test for malformed input and neighboring parser verdicts | Criterion 14 holds; malformed remains non-overridable |

## Open Questions

(none) — the operator confirmed explicit background timeout versus omission, and successful-call-only streak reset. Internal error representations must follow the existing contracts below rather than introducing new policy questions.

## Inherits / Changes

### Cited from `docs/CONTEXT.md` (verbatim terms)

- **hard-wall**: “A pre-execution shell-intent filter over enumerated syntax; a matched deny cannot be overridden by a session grant, while a clean scan does not certify an interpreter's runtime effects.” (ADR-0068 / ADR-0125 / ADR-0129.)
- **per-call tool timeout**: “ACI/executor 档位钟到点 → 只该条 `execution_failed` 且 `message` 为 `"timeout"`；loop **不**因此 `StopReason: timeout`。” (ADR-0091.)
- **会话 tmp**: “每个身份（主会话或一个 worker）在会话文件夹里的宿主目录；模型与 `$TMPDIR` 用这条真路径；不 bind 成 Linux `/tmp`。” (ADR-0092.)
- **评测态 (eval state)**: “**hard-wall** 与 which-tree 轴不随围栏退场；此态下的分数不构成关于围栏的证据。” (ADR-0130.)

The existing closed `StopReason` contract distinguishes `cancelled` from `timeout`; a per-call timeout does not independently stop the loop (ADR-0029 / ADR-0091). The active `taskRoot` remains the existing task workspace anchor; this specification adds no new root identity.

### Existing contracts this spec depends on

- ADR-0131 owns the three sensitive-path evidence outcomes and retains the current `SENSITIVE_PATH_FRAGMENTS` roster, end anchors, handler/policy shared-result requirement, and ADR-0124/0127 routes.
- ADR-0132 owns identity-scoped scratch cleanup, the trusted host snapshot, non-recursive `rm -f`, all-target containment, and the no-read/no-cross-identity boundary.
- The existing permission policy owns the ordinary mode-based permission flow. ADR-0004 owns the tool-layer contract, with its Bash timeout-exposure clause amended by ADR-0134. `default` and `full_auto` remain the existing permission modes; hard walls run before grants and mode handling.
- ADR-0091 and ADR-0108 own per-call timeout, cancellation, and in-flight closeout semantics. This spec changes the finite Bash timeout input/default without redefining Loop Engine `StopReason`.
- ADR-0128 / ADR-0129 continue to own canonical read policy and protected filesystem effect enforcement. A root-search policy relaxation does not remove those controls.
- ADR-0130 keeps hard walls active in `eval state`; eval scores alone are not evidence that the filesystem fence works.
- Existing foreground Bash, explicit background task manager, TERM/grace/KILL cleanup, JSONL trace service, and Harbor task-result/grader surfaces are reused. The evaluator's raw result stays authoritative for benchmark pass/fail.

### Changes required by this spec

- Change sensitive-path and destructive-command intent decisions only as scoped by ADR-0131/0132 and the workspace/root-search rules above; keep admission and handler behavior aligned.
- For finite foreground Bash, use a 10-second default and a model-supplied per-invocation runtime override, replacing the old fixed Bash build tier as a nested limit. Do not add the previously discussed root-search 30-second cap or ordinary-command 300-second cap.
- Enforce launch-time deadlines for background calls with explicit `timeout_ms` and truthful bounded cleanup; omission preserves the existing persistent-service lifecycle.
- Stop the current turn after the agreed confirmed-violation threshold while retaining session state; do not accumulate counts across turns. Preserve `StopReason` and use the existing cancellation outcome with structured cause and cleanup state. Only an admitted successful tool call resets the within-turn streak; neutral failures preserve it and each new user turn starts at zero.
- Add trace-backed attribution alongside the raw benchmark outcome. Do not claim all CLI entrypoints already emit the same content trace.
- **Persistence completed:** ADR-0131/0132 carry sensitive-path and identity-scratch decisions; ADR-0133 records ordinary workspace cleanup; ADR-0134 records the Bash timeout/background contract and partially supersedes ADR-0004 Decision 1; ADR-0135 records current-turn security interruption. No new domain term was required.

## Architecture review and handoff

Reviewed on 2026-09-30 against this specification; these are design verdicts, not runtime test results.

- bounded-context-guardian: yes — shared admission evidence, process execution, turn ownership, and evaluation evidence stay in their existing bounded responsibilities.
- input-contract-tests: yes — the proposed matrix covers omitted/invalid/negative/overflow inputs, concurrent calls, and launch/teardown exceptions.
- error-handling-enforcer: yes — typed validation and cleanup outcomes preserve timeout/cancel envelopes and explicit bounded exit conditions.
- complexity-anti-drift: yes — classification, timeout resolution, process cleanup, violation state, and trace evidence have separate responsibilities.
- minimal-change-verifier: yes — one #1170 repair outcome; image caching, model capability estimates, and unrelated runtime-tier changes remain out of scope.

Downstream input: `specs/hard-wall-denial-alignment.md`. The next workflow is `writing-plans` if requested; no implementation plan or code execution is started by this specification. Product verification must collect the matrix evidence before claiming the repair is complete. Follow the repository's one-logical-task-per-PR convention; the contract does not mandate separate PRs for incomplete parts of the repair.
