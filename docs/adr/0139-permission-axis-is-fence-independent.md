# 0139. The permission axis is fence-independent: yolo writes the fence axis only

Date: 2026-10-06
Status: accepted
Deciders: operator
Related: ADR-0119 (yolo mode — this amends its ruling 1 and Amendment 2026-09-20 (ii)), ADR-0130 (eval state — re-adjudicated here, see §3), ADR-0092 (fs isolation modes), ADR-0030 (graph mode overlay), ADR-0068 (hard wall), ADR-0084 (user-layer settings discipline), ADR-0097 (the egress exemption rides the fence)

Spec: `specs/permission-axis-semantics.md` (the axis contract this ADR names; opened by this decision).

## Context

ADR-0119 added `--yolo` as the operator-locked exemption face of the sandbox discipline, and coupled it to the permission axis on entry: entering yolo also wrote the permission holder to `full_auto`. Its ruling 1 called yolo "an independent boolean state axis" and, in the same breath, said "Entering yolo **implies** setting the permission holder to `full_auto` (reusing existing semantics, hard-wall pre-filters included)."

That coupling is one line — `opts.permission?.set(YOLO_PERMISSION_TARGET)` in the shared enter action (`src/harness/sandbox/yolo.ts`) — and it was reasoned, not accidental. Amendment 2026-09-20 (ii) records the load-bearing form of the argument: _"a session that displays YOLO must also behave YOLO from its first tool call"_, i.e. **the red marker and the permission posture were held to be one contract**, so that a YOLO session has no second, less-dangerous-looking state to be in.

Two things have changed since, and together they dissolve the argument without weakening anything it protected.

**First, the "no second state" problem is solved by a mechanism the ADR already had.** The concern behind the coupling — that a session could _look_ maximally dangerous while behaving less so — is a UI-honesty concern, and a snapshot answers it directly: the permission axis is snapshot on entry and restored on exit, so the state that used to be unreachable ("fence retired, permission still per-call") is now a state the session can enter and leave cleanly, and can _be_ in while the marker is up. The marker no longer has to imply the posture; it can simply report the fence, because the posture is separately visible and separately reversible.

**Second, the orthogonality argument has been made backwards.** ADR-0119's own Basis for ruling 1 says the two axes' orthogonality is what guarantees Shift+Tab still works under yolo. But Shift+Tab already changes the permission mode under yolo today — ADR-0030's three-state cycle freezes graph mode's permission at whatever value is current, and graph mode is reachable from a yolo session. The mechanism that keeps a mid-session permission change safe is the snapshot, not the orthogonality claim. The claim is therefore not what carries the property, and cannot be what justifies the coupling.

What remains is a decision the ADR should have separated: **whether the fence axis may write the permission axis.** Two axes are orthogonal precisely when neither writes the other, and the permission axis's meaning does not vary with the fence. In fact the fence _depends_ on the permission axis being stable — the sandbox discipline's whole design is "fence plus per-call questions", and a fence that silently disarms its own questions is not a stricter sandbox, it is a different product.

## Decision

**Yolo's entry writes the fence axis only.** It sets `fsMode → global` and `yolo → true` through their holders, exactly as before. It does not touch the permission holder, on any entry path.

**The permission axis is fence-independent in both directions.** A fence change never moves the permission mode; a permission-mode change never moves the fence. Each is set, read, snapshotted, and displayed on its own terms.

### 1. What changes in the product

- The yolo controller's enter action drops its permission write; its exit restores only the `fsMode` snapshot. The launch entry (`--yolo` before the TUI starts) applies the same combination, so a `--yolo` session's permission posture is whatever the session would otherwise have — which is the operator's own `IKNOW_PERMISSION_MODE` / project `defaultMode` / `default` chain, unchanged.
- **The two user-facing statements that asserted the coupling are corrected in the same change.** The yolo confirmation modal (`src/tui/yolo-picker.tsx`) described the permission face as switching to `full_auto`; the exit notice (`YOLO_EXIT_TEXT`) said permission and fs mode both rolled back. Both were true when written and become false here. A mode change that leaves the interface asserting something untrue is not a partial change.
- ADR-0119's ruling 1 and Amendment 2026-09-20 (ii) are **amended** to match. The amendment is not cosmetic: the "display YOLO ⇒ behave YOLO" sentence is retired, and what replaces it is a weaker and more accurate claim — the marker reports the fence, the mode row reports the permission posture, and the two are independent.

### 2. The newly-reachable combination: no fence, per-call questions

This posture is now reachable and was not before. It is named here so it is not left as an unnamed state:

**`fsMode` global, no fence, `default` permission.** Every call the model makes is subject to the normal per-call question; hard walls and security review still pre-filter; there is simply no fence to contain a mistake between questions. Its use is narrow and deliberate — a session where the operator wants to approve every command but does not want the fence's mount restrictions to shape what the agent may attempt (for example, when the environment already provides its own containment, or when diagnosing fence behaviour). It is **not** the safer choice: it removes a boundary and keeps a process. Anyone reaching for it should read ADR-0097 first, since under yolo there is no netns and therefore no egress seam at all.

Two neighbouring postures follow from the same decision and are equally named: **no fence + `plan`** (questions never arise; the session reads) and **fence + `full_auto`** (no questions; the fence is the boundary — `full_auto`'s own contract, narrowed by ADR-0140).

### 3. Eval state is re-adjudicated here

ADR-0130 grounded eval state's parity with yolo **structurally**: "The carrier is therefore the very same `YoloContext` holder … applied by the very same enter action — the parity is structural, not a copy that could drift." Removing the permission write from that shared action would silently move eval's posture, and ADR-0130 §4 lists "`full_auto` alone" among its rejected options (it fixes approvals, not the fence — but approvals are what eval needs too).

**Eval state keeps `full_auto`, written explicitly by its own entry.** The parity sentence is corrected rather than deleted: eval and yolo share the **fence carrier and the fence posture** (same holder, same factory branch, same four bare routes, same retired egress seam); the **permission posture is set by each entry separately** and is no longer evidence of parity. This is the correct direction of the correction — the drift ADR-0130's sentence was defending against is a _fence-shape_ drift, which the shared holder still prevents, and not a permission drift, which was never the risk.

**Basis:** ADR-0130 §1 names permission → `full_auto` as part of the combination eval applies; §2 records the hard wall as intercepting "before `full_auto` grants anything", which presupposes `full_auto` is in force. Eval is a benchmark entry: an operator cannot answer questions mid-run, so per-call questioning would deadlock it. Its permission posture must therefore remain the non-questioning one, set explicitly.

### 4. What this ADR does not decide

- **`full_auto`'s own semantics.** That the mode is bounded — that a call leaving the fence's reach is asked about rather than either silently allowed or silently failed — is a separate decision with its own blast radius (ADR-0140). This ADR only establishes that the fence and the permission axis no longer write each other; it does not give `full_auto` new behaviour.
- **`specs/yolo-mode.md`.** That spec is operator-locked (issue #1035 ballot) and its five-dimension table still describes the coupled entry. It is **operator input pending**: this ADR states the coupling is over and the spec must be re-issued to match, but the edit is the operator's to make.
- **The legacy compatibility entry** (`src/harness/aci/permission.ts`), which does not forward `mode` and therefore judges every call through it as `default`. Recorded because it is now more visible: a path that ignores the permission axis entirely was always wrong, but it was less noticeable while the axis had fewer moving parts.

## Consequences

- **Positive:** the two axes can now be reasoned about, tested, and displayed independently. A user who wants the fence off but still per-call questions (or the reverse) has a name for what they are asking for. `full_auto`'s label is no longer load-bearing on a coupling that was never about it.
- **Negative / trade-offs:** a yolo session no longer implies `full_auto`, so a user who reaches for yolo expecting "everything, no questions" and is in `default` will get questions. This is a real behaviour change on the entry path and is the cost of the two axes being honest. The mitigation is discoverability, not a re-coupling: the mode row shows the posture independently of the yolo marker, and the entry notice states what yolo changed (the fence) and what it did not (the permission mode).
- The defence line for the sandbox discipline is unchanged in strength. ADR-0119's entry enumeration (typed refusals on `chat` / `serve` / `ask` / `oneshot` / `trace`), its non-persistence ruling, and its no-half-bare ruling all stand verbatim; what is retired is only the claim that the permission posture was part of the fence's exemption.

## Evidence pointers

- Yolo enter / exit / launch actions and their snapshot: `src/harness/sandbox/yolo.ts` (`createYoloController`, `applyEnterCombination`, `enterAtLaunch`, `exit`).
- The two user-facing statements corrected by §1: `src/tui/yolo-picker.tsx` (confirmation copy) and `YOLO_EXIT_TEXT` in `src/harness/sandbox/yolo.ts`.
- Eval's structural-parity claim re-adjudicated by §3: `src/harness/sandbox/eval-state.ts` (module contract) and ADR-0130 §1 / §2 / §4.
- Fence retirement as the single SSOT branch: `src/harness/sandbox/bwrap.ts` (`createBwrapFence`'s yolo early return, ahead of the boundary-mount assembly).
- The permission axis this ADR declares fence-independent: `src/harness/permission/modes.ts` (`PermissionMode`, `PermissionModeContext`), decided by ADR-0032 and constrained by ADR-0090's project-layer rule.
- Yolo's fence-axis exemptions unchanged: ADR-0097 (egress seam), ADR-0109 (in-fence ro-bind rides the fence), ADR-0037 / ADR-0096 (worktree gate stays).
