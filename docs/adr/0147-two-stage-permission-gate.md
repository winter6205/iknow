# 0147. One scan per wave — the verdicts are taken where they are enforced; a two-stage gate inside one wave

Date: 2026-10-19
Revised: 2026-10-20 (after the code review)
Amended: 2026-10-20 (held-call visibility and approval timeout — see Amendment 2026-10-20)
Status: accepted
Deciders: operator
Related: ADR-0141 (presets on one session overlay — its §3 permission-axis clearing points are untouched here, and an "always allow" answer clears nothing), ADR-0140 (`full_auto` is bounded — the boundary question stays a per-call question), ADR-0127 (security review — its route and its position below the wall are unchanged), ADR-0068 (hard wall — unchanged), ADR-0132 / ADR-0133 (the host root context — read once per decision), ADR-0114 (the hydrate gate — unchanged), ADR-0101 (same-round parallel spawn — the wave shape this gate runs in)

Spec: none — this is a performance decision inside the permission layer; the policy it evaluates is pinned by `src/harness/permission/policy.ts` and the wave shape it encodes is the shared partitioner's rule (`src/harness/tools/concurrency-waves.ts:5-24`), applied incrementally in `src/harness/aci/aci-executor.ts`.

## Context

**Facts 1–3 are the base's facts, verified at `649f4cc7`** (the commit before this change). Every line number in facts 1–3 is that commit's; every line number from §Decision on is the current working tree. Fact 4's test citation is the current working tree's — the test file did not exist at `649f4cc7`.

**1. One call is evaluated three times.** For every tool call in a wave, `checkPermission` runs three times: once in the wave prediction (`src/harness/aci/aci-executor.ts:270-276` at `649f4cc7`), once for the observer event (`src/harness/aci/aci-executor.ts:302` at `649f4cc7`), and once in the enforcing gate (`src/harness/permission/permission-executor.ts:414-423` at `649f4cc7`). The three are three separate calls to the same resolver — pure in its declared inputs — and the observer and the gate each rebuild the input set by hand to keep their verdicts aligned; the observer's own comment states that requirement (`src/harness/aci/aci-executor.ts:308-311` at `649f4cc7`).

**2. The three evaluations do not read the same inputs.** The prediction passes only `sources`, `hardWalls` and `defaultByCategory` (`src/harness/aci/aci-executor.ts:270-276` at `649f4cc7`); it passes no mode, no host roots and no fs boundary. The observer and the gate pass all of them (`src/harness/aci/aci-executor.ts:312-321` and `src/harness/permission/permission-executor.ts:420-422` at `649f4cc7`). The gap is not academic: `checkPermission`'s mode step answers `plan` with a **deny** for a mutating category (`src/harness/permission/policy.ts:539-546` at `649f4cc7`), and a prediction that cannot see the mode cannot see that deny. The observer and the gate agree at `649f4cc7` only because each of them re-derives the same input set by hand, at the same moment — an alignment with no mechanism behind it.

**3. A wave waits for its questions.** `runWave` gates the whole wave before it starts any of it: the loop at `src/harness/aci/aci-executor.ts:349-357` (at `649f4cc7`) awaits `perm.gateOne` for each call in order, and only the `Promise.all` at `:358` (at `649f4cc7`) starts the executions. An allowed call therefore waits for every approval question in its wave to be answered, although it needed no answer. In a wave of N calls with K questions, every allowed call starts only after all K human round-trips are over.

**4. A batch-level plan phase is a fail-open.** The first implementation of this ADR took every call's verdict in a batch-level plan phase — before the first wave ran — and reused it for the wave's shape, the observer and the gate. A verdict taken before the batch ran is a verdict the gate may no longer be able to enforce: the permission mode can be flipped between two waves, and the base's gate, which computed its own decision at gate time (`src/harness/permission/permission-executor.ts:414-423` at `649f4cc7`), would have denied the mutating call under the flipped `plan` mode (`src/harness/permission/policy.ts:539-546` at `649f4cc7`). The code review reproduced exactly that: a mutating call executed under a stale `full_auto` verdict that the base denied. Test (e) (`tests/harness/aci/aci-executor-permission-gate.test.ts:442-520`) is the regression test: the mode is flipped while the first wave runs, and the mutating call in the second wave must be denied.

## Decision

### 1. The wave scan: the shape and the verdicts are taken together, per wave

`executeAll` scans the waves **one at a time** (`src/harness/aci/aci-executor.ts:236-270`): each wave's SHAPE and its members' VERDICTS are taken together, right before that wave runs. `scanWave` (`src/harness/aci/aci-executor.ts:342-376`) walks the pending calls, takes each call's verdict through `decidePermission` (`:357-360`), and cuts the wave at the first call that does not belong in it (`:361-373`).

The scan encodes the shared partitioner's rule **verbatim**: a call joins the current wave iff it is concurrency-safe **or** its verdict is `deny` (`src/harness/aci/aci-executor.ts:361`; the rule's own statement at `src/harness/aci/aci-executor.ts:323-328`). A denied call has no side effect, so it rides along in its neighbours' wave — the #653 behaviour (`src/harness/tools/concurrency-waves.ts:2-4`).

The rule is applied **incrementally** here, not by `partitionConcurrencyWaves` over the whole batch. That partitioner scans the entire array in one pass (`src/harness/tools/concurrency-waves.ts:5-24`), so its predicate would decide every call before the first wave ran — the staleness this scan exists to remove. **The shared partitioner is no longer called from this module** (the import is gone from `src/harness/aci/aci-executor.ts`; the partitioner is still called by the engine for its own batch split, `src/harness/loop-engine.ts:3147-3153`). The wave shape is unchanged: for the same verdicts the scan produces the same waves the partitioner produced (join → the current wave, break → the next wave).

The scan is per wave, never per batch. A verdict taken before the batch ran can be contradicted by the state the gate enforces it under, and a stale verdict is a fail-open (Context fact 4).

### 2. The boundary probe: a call that breaks a wave is decided twice

A call that breaks a wave is decided **twice**: once as the boundary probe in the previous wave's scan (`src/harness/aci/aci-executor.ts:357-360`, the verdict computed before the wave is cut at `:366-370`), and again in its own wave's scan — the probe taken in the previous wave's scan would be stale by the time that wave runs. Every other call is decided once.

The real count is therefore:

> **total decisions = N + B + A**, where N is the number of calls, B the number of wave boundaries (one extra probe each) and A the number of calls that take the approval path (one extra re-decision each, §7).

Test (a) (`tests/harness/aci/aci-executor-permission-gate.test.ts:261-311`): N=2, B=0, A=1 → 3 decisions. Test (e) (`:442-520`): N=3, B=1, A=0 → 4 decisions. Test (k) (`:744-802`): N=3, B=0, A=0 → 3 decisions.

### 3. The observer's position: before the prepare, with the scan's verdict

The observation event fires for a call **before that call's prepare**, carrying the scan's verdict (`src/harness/aci/aci-executor.ts:469-480`: `emitOnDecision` at `:472`, then `prepareOne` at `:476`). The observer therefore reports the very verdict the gate enforces on the allow/deny path — `emitOnDecision` hands the scan's outcome over unchanged (`src/harness/aci/aci-executor.ts:378-395`).

Because the prepare loop walks the whole wave before any approval is asked, **the whole wave's observer events and pre-hooks precede the wave's first approval prompt**. Test (i) (`tests/harness/aci/aci-executor-permission-gate.test.ts:697-742`) pins that order. This ordering is new in this revision: the first implementation of this ADR ran the observer inside the gate's own per-call sequence, and the plan did not disclose the change.

The observer's verdict is the enforced verdict **on the allow/deny path only**. On the approval path the enforced verdict comes from the pre-prompt re-decision (§7) and may differ from what the observer reported — the "always allow" case: the observer reports `ask` for a call the gate then admits silently. Test (h) (`tests/harness/aci/aci-executor-permission-gate.test.ts:648-695`) witnesses it.

### 4. The per-call order: verdict → hydrate → pre-hook → inner

The order inside one call is:

1. the **verdict**, taken in the wave scan, just before that wave's gate (`src/harness/aci/aci-executor.ts:357-360`);
2. the **hydrate path** (`src/harness/permission/permission-executor.ts:440-476`);
3. the **pre-hook** (`src/harness/permission/permission-executor.ts:478-505`);
4. the **inner execution** (`src/harness/aci/aci-executor.ts:576-608`).

The earlier wording in this ADR — "hydrate → pre-hook → decision → inner" — is no longer true: the decision is not taken inside the gate any more on the allow/deny path; it is taken by the scan and handed to the gate (`src/harness/permission/permission-executor.ts:398-405`, `effectiveDecision` returns the caller's verdict when there is one).

The pre-hook is **deny-only** (`src/harness/permission/hooks.ts:33-36`; the type makes it a compile-time fact — `src/harness/permission/types.ts:135-144`, `:146-161`): it can block a call but never change a verdict.

One pre-existing exception is unchanged and is not a permission verdict: the hydrate path's own two exits — a valid input returns `proceed` (skipping the pre-hook), a schema failure returns a schema projection — decide nothing and do not consult the caller's verdict (`src/harness/permission/permission-executor.ts:450-475`).

### 5. The decision's inputs are the enforcing gate's inputs

The verdict is assembled by `decidePermission` (`src/harness/permission/policy.ts:477-493`) from the enforcing gate's own input set: the permission layers (`sources`), the hard walls, the mode, the host roots and the fs boundary. The mode input is the same `PermissionModeContext` holder the gate reads (`src/harness/permission/policy.ts:489`; the holder's declaration at `src/harness/permission/modes.ts:52-55`).

The holder **is** the effective permission value on the decision path, and this ADR introduces no second source of truth for it. ADR-0141 already writes the preset overlay's declared permission tier into that holder when the yolo preset is entered (`src/harness/sandbox/yolo.ts:509`), precisely because the permission policy reads the holder and nothing else (`src/harness/sandbox/yolo.ts:502-508`). The overlay's own `effectivePermission()` (`src/harness/sandbox/no-sandbox-marker.ts:109-110`) is a separate derived read with a different consumer — the Shift+Tab wheel steps from what the operator sees (`src/tui/app.tsx:5563` → `src/harness/graph/mode.ts:197-199`) — and the decision path does not consult it.

The fs boundary keeps arriving as a closure handed down from the composition root (`src/harness/permission/policy.ts:232-239`), so the `permission/` layer keeps no import of `sandbox/` and the dependency stays one-way (`sandbox/` imports `permission/`, never the reverse). The `aci/` layer's own `sandbox/` imports are unchanged by this ADR; what it does not gain is a new one.

### 6. Two stages inside one wave

A wave is gated in two stages:

1. **Stage one — what the decision says.** A call whose verdict is `allow` starts executing **immediately**: it waits for no other call in the wave, and in particular not for a question about an earlier call. A call whose verdict is `deny` is blocked and its result is produced without touching the inner executor, as before.
2. **Stage two — what the operator is asked.** A call whose verdict is `ask` is put to the operator **one at a time, in tool_use order**. At most one approval request is in flight at any moment, across the whole wave (`src/harness/aci/aci-executor.ts:527-553` — the approvals are awaited in a `for` loop, so the next question is only raised after the previous one is answered).

The three stages in the code are: prepare (observer + the gate's non-approval part, for every call in the wave, in input order — `src/harness/aci/aci-executor.ts:464-480`), start (the allowed calls start immediately, concurrently — `:482-519`), and ask (`:521-553`).

The result backfill order does not change: the loop engine buffers out-of-order settlement and commits the results in tool_use order by prefix (`src/harness/loop-engine.ts:3066-3096`, the settle callback at `:3102-3106`). A call that answers late therefore still lands in its own slot. `onSettled` fires exactly once per result, with the index of the call within the array the executor was handed (`src/harness/aci/aci-executor.ts:561-564`, `:602-605`, `:648`; the engine hands the executor one wave at a time, `src/harness/loop-engine.ts:3097-3112`).

One ordering guarantee does change, and it is stated here so that no reader has to infer it: a call's permission evaluation still precedes that call's inner execution, and the questions are still serialized, but an allowed call's inner execution may now run **while another call's question is pending**. The executor's own comment records the current shape (`src/harness/permission/permission-executor.ts:279-283`): within one call the order is the verdict → hydrate → pre-hook → inner, and **across** calls it no longer holds. It still holds within a call: that call's verdict, hydrate step and pre-hook all precede its own inner. (§4 gives the current per-call order.)

The consequence of that reordering for the _verdict_ is a named window, stated in §10: because the wave's verdicts are sampled in the wave's scan and the allowed calls start before the wave's questions resolve, a permission-mode change landing **during** the wave's questions is not seen by that wave's already-started allowed calls. The next wave samples it fresh. The ask path is unaffected — §7's pre-prompt re-decision reads the live state.

### 7. One re-decision before each prompt

Before a prompt is shown, the decision for that call is re-evaluated once, against the current policy state (`src/harness/permission/permission-executor.ts:539-552`, the re-decision at `:544`). The re-evaluation is what makes a mid-wave answer take effect: an "always allow" answer is recorded as a **tool-scoped session grant** (TUI: `src/tui/app.tsx:3729-3736`; serve: `src/session-api/hub.ts:2621-2627`), the session layer is read live on every check (`src/harness/permission/policy.ts:689`), and the session layer outranks the project and code layers (`src/harness/permission/policy.ts:670-674`). So if the operator answers an earlier prompt with "always allow", the next same-tool call in the same wave is no longer asked: its re-evaluation sees the live grant and admits it (test (c), `tests/harness/aci/aci-executor-permission-gate.test.ts:365-403`).

The re-evaluation is one extra decision per prompt, and it happens **before** the prompt is shown — never after the answer. It is the reason the enforced verdict on the approval path is not the observer's verdict (§3).

### 8. The inner-failure semantics

A call whose inner execution **rejects** now gets an `execution_failed` **result** for that call; the wave still delivers one result per call (`src/harness/aci/aci-executor.ts:625-652`: the wave's results are collected with `Promise.allSettled` at `:629`, and a rejected slot becomes an `execution_failed` result at `:639-649`). The base propagated the rejection out of `executeAll` (`Promise.all` at `src/harness/aci/aci-executor.ts:358` at `649f4cc7`), discarding the wave's other results.

The rejection handler is attached when the inner **starts**, not at the wave's final aggregation (`src/harness/aci/aci-executor.ts:606`). The two-stage gate opens a window — the approval round-trips can take minutes — in which an inner rejection would otherwise be an unhandled rejection, and Node kills the process on one. The original promise stays in the wave's work list, so the aggregation still observes the very failure the inner raised (`src/harness/aci/aci-executor.ts:602-607`).

If the approval loop itself throws, the in-flight calls are settled before the error propagates unchanged (`src/harness/aci/aci-executor.ts:450-460`).

### 9. The retained test seam

`PermissionPolicy.check?` (`src/harness/permission/policy.ts:119-131`, the field at `:131`) is a **production seam**: `decidePermission` calls it in place of `checkPermission` when it is present (`src/harness/permission/policy.ts:482`). Absent → `checkPermission` itself, so production behaviour is byte-identical.

The seam is retained because the decision count is the only honest witness of this ADR's central claim, and a mock would witness a proxy instead. The counting policy **delegates to the real `checkPermission`** and only records what it returned (`tests/harness/aci/aci-executor-permission-gate.test.ts:216-223`); the session layer's rule read is a second, seam-independent witness of the same count (`:208-214`, asserted at `:286-292`). The repo already uses this pattern: `timeoutMsOverride` in `AciExecutorOptions` is explicitly a "Test seam" (`src/harness/aci/aci-executor.ts:119-125`).

### 10. What this does not change

- **The hard wall still runs first, and the security review still runs above the layers.** `checkPermission`'s order is untouched: hard walls (`src/harness/permission/policy.ts:441`), then the security review (`:450`), then the layered rules (`:455`), then the mode + category default (`:459`).
- **A security-review requirement is still answered only through the review route.** A decision that carries a requirement goes to the review route, never to the ordinary approval inlet (`src/harness/permission/permission-executor.ts:566-568`), and a call with no review route is denied rather than asked (`:352-357`). The re-decision of §7 keeps this: a re-decided decision that carries a requirement still routes to the review.
- **No policy is relaxed; the _sampling time_ of a verdict is.** The same inputs, the same policy and the same order produce the same verdicts (`src/harness/permission/policy.ts:426-465`). The decision-count reduction is a performance property, not a policy change. What a re-decision may change is the _live state_ the policy reads — a session grant the operator himself added — never the policy.
- **The one window where a wave's verdict can be older than the base's is named here, because the earlier wording of this bullet ("No verdict is relaxed") was absolute and therefore wrong.** A wave's allow/deny verdicts are sampled in that wave's **scan** (§1), and an allowed call's inner execution starts **immediately** — before the wave's questions are answered (§6). So a permission-mode (or host-root / fs-boundary) change that lands **after a wave's scan and while that wave's questions are still pending** is not seen by that wave's already-started allowed calls; the **next** wave samples it fresh. Under the base, each call was decided at its own turn, i.e. after every earlier call's question had resolved, so the base would have re-read the new state for the later call. The divergence is therefore a **sampling-time** difference, not a policy difference: for a change that _restricts_ the mode, the base is stricter for the calls it had not yet started; for a change that _permits_ more, the base is looser. The ask path is not affected — §7's pre-prompt re-decision reads the live state, so a change landing before a prompt is seen by the call that is about to be asked. **Amendment 2026-10-20:** the operator accepts this window on the condition that the agent is told when it was open — the held call's result names the sibling calls that ran under the wave-start verdict (R3), and a held call is call-addressed and observable while it waits (R1).
  - Concretely, and pinned by a test: a wave `[allow, ask, allow]` whose permission mode is flipped to a restrictive one **while the question is pending** leaves the wave's already-started allowed call running under the verdict it was sampled with, while the base denied it (`tests/harness/aci/aci-executor-permission-gate.test.ts`, the "mid-wave permission change" case). The wave's own scan is what makes the first two calls start before the answer (§6); a wave that waited for its questions would restore the base's ordering and lose the property this ADR exists to deliver.
  - Reachability: the change must land inside the wave's question window. The executor does not exclude it, and the TUI's permission wheel is not gated on the ask modal being closed: the global key handler's Shift+Tab arm (`src/tui/app.tsx:5546`) does not test `askModalActive`, and the ask modal's own key routing returns `ignore` for an unmatched key (`src/tui/modal.tsx:330-364`), so Shift+Tab is not consumed by the modal. The window is narrow and the next wave is always fresh — but it is a window, and it is fail-open by construction, so it is stated rather than implied.
- **ADR-0141 §3's two permission-axis clearing points stay exactly where ADR-0141 §3 puts them**: the `/permissions set` write (`src/harness/permission/permissions-command.ts:120-125`) and the Shift+Tab wheel's permission step (`src/harness/graph/mode.ts:209-212`). An "always allow" answer is not a permission-mode change — it writes a session grant and no mode (`src/tui/app.tsx:3729-3736`, `src/session-api/hub.ts:2621-2627`) — so it clears nothing.
- **At most one approval request is in flight** (`src/harness/aci/aci-executor.ts:532-553`; test (f), `tests/harness/aci/aci-executor-permission-gate.test.ts:522-584`).
- **The result backfill order stays tool_use order**, and the engine still buffers out-of-order settlement and commits by prefix (`src/harness/loop-engine.ts:3066-3096`, `:3102-3106`).
- **The wave shape rule is unchanged** (§1). The only wave-placement change follows from the verdict being taken per wave: a call the gate will deny is treated as side-effect-free for partitioning (`src/harness/aci/aci-executor.ts:361`). That moves a call only when it is not concurrency-safe, because a concurrency-safe call already does not break the wave.

### 11. Plan corrections

The plan this implements (`plans/perf-d1-permission-gate.md`, now in the repository) is corrected on six points, by the operator's decision. The deviations are on record here.

**C1 — the mode comes from the holder, and that is correct.** Plan line 20 says the decision's mode must be "the effective permission value (including the session overlay), computed from the same source as ADR-0141 §3, NOT read from the holder". The implementation reads the holder (`policy.mode`, `src/harness/permission/policy.ts:489`), and that is right: ADR-0141 writes the preset overlay's declared tier **into** that holder precisely because the permission policy reads the holder and nothing else (`src/harness/sandbox/yolo.ts:502-509`), and `permission/` must not import `sandbox/` — the layering rule at `src/harness/permission/policy.ts:232-239`. Reading `effectivePermission()` from the decision path is not implementable without breaking that layering. **The holder IS the effective value on the decision path.**

**C2 — the decision count.** The plan's Goal and test-map row 1 ("each call's pure decision runs exactly once") hold on the allow/deny path — **except at wave boundaries**, where the boundary probe adds one extra decision. The approval path adds one re-decision per prompt (the plan's own task 3 requires it), and the wave boundary adds one probe (§2). The real numbers are N + B + A.

**C3 — the decision is reused in the prediction, the observer and the gate.** Plan task 2 asks for exactly that, and it is what the code does: the scan's verdict decides the wave's shape (the prediction), is reported by the observer, and is what the gate enforces on the allow/deny path. The difference from the plan is only the **moment** the verdict is taken — per wave, not per batch — which the fail-open of Context fact 4 forced. On the approval path the gate enforces the pre-prompt re-decision (§7).

**C4 — the plan's Invariant "判定结果与现状逐条一致，不放宽任何 deny / ask" is not literally satisfiable together with plan task 3.** Task 3 requires the two allowed calls of an `[allow, ask, allow]` wave to start **before** the ask is answered (its own Test map row demands it), while the Invariant demands each call's verdict match the base — and the base decided each call at its own turn, i.e. after the earlier question had resolved. The two cannot both hold when the permission state changes inside the wave's question window. The implementation keeps task 3 (it is the point of the ADR) and keeps the Invariant's _intent_ — no policy is relaxed, every verdict is a real `decidePermission` result on the gate's own inputs — and §10 names the window the ordering opens. The plan's Invariant is amended to read "判定结果与现状逐条一致（**一波之内**的取定时刻除外：该波已开跑的 allow 调用不回头改判，下一波取新判定）". The acceptance of this amendment is conditional: see Amendment 2026-10-20 (R1–R5), which makes the window visible to the agent without changing any verdict.

**C5 — the executor's failure contract changed, and no plan task asked for it.** A call whose inner execution **rejects** is now that call's `execution_failed` **result**, and the wave still delivers one result per call; the base propagated the rejection out of `executeAll` and discarded the wave's other results. §8 gives the reason (the two-stage gate opens a window in which an inner rejection would be an unhandled rejection, and Node kills the process on one). The plan is amended to carry the change; the contract is on the record here and in the plan, not only in the code.

**C6 — the production `PermissionPolicy` gained an optional `check` seam.** `src/harness/permission/policy.ts` now carries `check?: (input) => PermissionOutcome` beside the existing `timeoutMsOverride` seam, and `decidePermission` calls it when present. Absent → `checkPermission` runs unchanged, so the production path is byte-identical to the base; the seam exists because the plan's own task-1 counting test needs to COUNT the pure decisions, and the counting seam delegates to the real `checkPermission` rather than replacing it (the test file says so, and a second, seam-independent witness — the session source's rule-layer read count — backs it). §9 gives the reasoning. The plan gains no task for it, so it is recorded here: every plan↔code delta is enumerated in this section.

## Alternatives rejected

- **Keep three evaluations and align the prediction's inputs by hand.** Rejected: it leaves the alignment to a human copying a field list, and it keeps three evaluations where one suffices.
- **Take every call's verdict in a batch-level plan phase, and reuse it for the whole batch.** Rejected: it is a fail-open. A verdict taken before the batch ran can be contradicted by the state the gate enforces it under — the permission mode can be flipped between two waves — and the code review reproduced a mutating call executing under a stale verdict that the base denied (Context fact 4). This is the alternative the repair replaced with the wave scan.
- **Cache the decision across the whole turn.** Rejected: a decision that outlives its wave would be a stale answer to a question whose inputs (session grants, mode) are live. The re-evaluation of §7 is deliberately scoped to the moment a prompt is about to be shown.
- **Ask all of a wave's questions at once, in parallel.** Rejected: the operator would have to answer several questions at the same time, and the answers would no longer be attributable to one call in tool_use order.
- **Keep the wave's gate-then-run barrier (ask everything, then start everything).** Rejected: it is the shape that makes an allowed call wait for K human round-trips.
- **Keep calling the shared partitioner and give it a per-wave input.** Rejected: the partitioner's contract is one array in, one array of waves out (`src/harness/tools/concurrency-waves.ts:5-24`); feeding it one wave at a time would re-introduce the per-wave scan in a place whose predicate is a boolean, with no room for the verdict the scan needs.

## Consequences

- A wave of N calls with B boundaries and A approval-path calls now costs N + B + A decisions, against 2N at the base (3N when an `onDecision` observer is wired — the base's observer made its own call, `src/harness/aci/aci-executor.ts:302` at `649f4cc7`). The observer now adds no decision at all.
- An allowed call starts as soon as its own wave is scanned, so its execution overlaps the wave's questions instead of following them.
- The observer and the gate read one verdict on the allow/deny path, so they cannot disagree. On the approval path the enforced verdict is the pre-prompt re-decision and may differ from the observer's.
- A wave's side effects may now interleave with a pending question (§6).
- A call that breaks a wave is decided twice; the second verdict is the one that is enforced.
- Under `plan` mode a mutating call is predicted denied and is therefore treated as side-effect-free when the wave is partitioned.
- A call whose inner execution rejects no longer discards its wave's other results.

## Out of scope (separate follow-ups)

- Any change to the policy itself, to the hard walls, to the security review or to the mode branch.
- Persisting or sharing decisions across waves or across turns.
- Changing the shared partitioner's rule (`src/harness/tools/concurrency-waves.ts:5-24`), which the engine still calls for its own batch split (`src/harness/loop-engine.ts:3147-3153`).
- The hydrate path's own two exits, which decide nothing and consult no verdict (`src/harness/permission/permission-executor.ts:450-475`).

## Amendment 2026-10-20 — the agent knows a call was held for approval

**Accepted condition.** The operator accepts §6 (an `ask` call is held while the wave's `allow` calls run) and the §10 window **on one condition: the agent, and every client that shows the question, knows which call is held, what became of it, and which sibling calls ran while it was held.** At `512a6a96` that condition is not met:

- the approval inlet receives `{tool, input, summaryHint, signal}` only (`src/harness/permission/types.ts:122-130`); the pending entries built from it — the TUI bridge's `TuiPendingAsk` (`src/tui/ask-user.ts:17-21`) and serve's `PendingAskView` (`src/harness/permission/ask-user.ts:162-167`, listed by `GET /sessions/:id/asks`, `src/session-api/http.ts:683-690`) — carry no `toolUseId` and no `conversationId`, so a client can match a question to a call only by tool name and hint;
- `runApprovals` (`src/harness/aci/aci-executor.ts:537-557`) emits nothing while it waits; no stream event says a call is held or released;
- an unanswered question, a failed prompt and an explicit "no" all reach the model as the same text, `[user_denied] user declined tool call: <tool>` (`src/harness/permission/permission-executor.ts:590-623`: the inlet's timer answers `false`, a throwing inlet is folded into `false`);
- an approved held call returns a result indistinguishable from an `allow` call, and a `[permission_denied]` produced by the §7 re-decision after a mode change says nothing about the sibling calls that already ran under the wave-start verdict (§10; test (p), `tests/harness/aci/aci-executor-permission-gate.test.ts:1161`).

The model cannot act mid-wave (it sees the wave's results when the next turn starts), so for the model "knowing" means the held call's own `tool_result`; for the operator and for clients it means a live, call-addressed pending state. The amendment requires both. **None of the five requirements changes a permission verdict, the wave shape, the order of questions or the §10 window; they add identity, events and text.**

**R1 — call-addressed pending state.**

- The approval inlet's input gains `toolUseId` (the call's `tool_use` id) and `conversationId` (absent only for a caller that has none, e.g. the bare-ACI prototype). The approval arm receives them from the wave (`WaveRunOptions.conversationId`, `src/harness/aci/aci-executor.ts:419` region) instead of guessing.
- The pending entries carry both fields: `TuiPendingAsk`, `PendingAskView`, and therefore the `GET /sessions/:id/asks` body and the web client's `PendingAsk` (`web/src/api/client.ts:310-314`). The TUI modal names the call it is asking about.
- `runApprovals` (through the approval arm) emits two stream events per question actually shown: `approval_pending {toolUseId, tool, conversationId?}` immediately before the inlet is invoked, and `approval_resolved {toolUseId, outcome}` when it settles, `outcome ∈ approved | declined | timeout | prompt_failed | cancelled`. A §7 re-decision that admits or denies without prompting emits neither (no question was shown).

**R2 — distinct results for distinct endings.** The `[user_denied]` code is kept for every ending in which no approval was obtained from the user; the message says which ending it was:

- explicit decline: `[user_denied] user declined tool call: <tool>` (unchanged);
- configured timeout elapsed: `[user_denied] approval timed out after <N>s with no answer: <tool>`;
- prompt failure (the inlet threw or is unavailable): `[user_denied] approval prompt failed (<sanitized cause>): <tool>`;
- caller cancellation keeps `cancelled` (`permission-executor.ts:68`) — the turn was aborted, the user did not decide.
  To carry this, an inlet answers a typed outcome (`approved | declined | timeout | cancelled`); a bare boolean stays accepted (`true` = approved, `false` = declined) so the TTY, fail-closed and no-ask inlets need no change. A throw is `prompt_failed`.

**R3 — the held call's result says it was held.**

- A call that went through a shown question carries one appended line in its `tool_result`, whatever the outcome: `[approval] held for user approval (<outcome>); calls that ran in this wave meanwhile under the wave-start verdict: <toolUseIds | none>`. "Ran meanwhile" means the calls of the same wave whose inner execution had started before this call's question settled (the wave's `allow` calls and earlier approved questions).
- A `[permission_denied]` that comes from the §7 re-decision of a call the wave scan had judged `ask` carries the same sibling list: `[approval] permission state changed while this wave was running; calls already started under the wave-start verdict: <toolUseIds | none>`.
- On an `ok` result the line is appended as a final text block after the tool's own payload; on a failure it is appended to the message. The text is the only change: no verdict, no ordering and no retry behaviour depends on it.

**R4 — no approval timeout by default.** An unanswered question stays pending until the user answers it or the turn is cancelled. Today the TUI inlet fails closed after 60 s (`src/tui/ask-user.ts:33`) and the serve inlet after 5 s (`src/harness/permission/ask-user.ts:192`); both defaults are removed.

- A timeout exists only when configured: settings key `approval.timeoutMs` (user and project layers, project wins, same resolution as `subagent.taskTimeoutMs`, `src/config/settings.ts:353-381`), with env override `IKNOW_APPROVAL_TIMEOUT_MS`. Absent or `0` means wait without limit; a positive integer is milliseconds; any other value is dropped with the existing invalid-field warning, which also means wait without limit.
- When a configured timeout elapses, the result is R2's timeout text. Cancellation (turn abort, the inlet's `signal`) still releases the waiter at once and yields `cancelled`.
- Explicit `timeoutMs` passed by an assembly (for example a bridge profile) keeps working and takes precedence over the setting.
- This supersedes the "5000 ms fail-closed default stays" clause of `specs/im-bridge-feishu.md` (S2); "fail-closed" continues to mean that no ending other than an explicit approval admits the call.

**R5 — tests.** Each requirement has its own test, asserting its own contract:

- R1: the inlet receives the call's `toolUseId` and the wave's `conversationId`; `pendingAll()` / `pending()` and `GET /sessions/:id/asks` carry both; `approval_pending` precedes and `approval_resolved` follows each shown question, with the right `toolUseId`, and neither fires on a silent re-decision.
- R2: one case per ending (declined, timeout, prompt failure, cancelled) asserting the exact message.
- R3: in `[allow, ask, allow]` the ask call's result names both allow calls' ids; in test (p)'s scenario the re-decided `[permission_denied]` names the calls already started; an `allow` call's result carries no `[approval]` line.
- R4: with fake timers, an unconfigured TUI bridge and an unconfigured serve handle are still pending after advancing past 60 s and 5 s respectively (and well beyond); a configured `approval.timeoutMs` yields the timeout outcome and text; an abort resolves `cancelled` with or without a configured timeout; the settings parser accepts absent / `0` / positive integers and drops the rest.

§10 and §11 C4 are read with this amendment: the window they name stays, and the agent is told when it was open.
