# 0140. `full_auto` is bounded: inside the fence no question, outside it a question

Date: 2026-10-06
Status: accepted
Deciders: operator
Related: ADR-0139 (the permission axis is fence-independent — this ADR decides what `full_auto` _means_ now that the axes no longer write each other), ADR-0092 (fs isolation modes; its rejected-option record is why the boundary question is not in `policy.ts`), ADR-0068 / ADR-0127 (the hard wall and the security review are pre-filters, unchanged), ADR-0090 (the project layer cannot grant itself this mode), ADR-0032 (the product word "auto mode" means `full_auto`), ADR-0030 (graph overlay)

Spec: `specs/permission-axis-semantics.md`.

## Context

`full_auto` is the third and last permission mode. Its implementation is four lines: `if (mode === "full_auto") return { decision: "allow", … }`, placed after the hard wall and the security review, and it grants **without asking anything**, whatever the current `fsMode` permits. Its UI label is "Auto".

That label is the problem, and it is two problems wearing one name.

**The label promises intelligence the mode does not have.** "Auto" has a settled meaning in this product's category since 2026 — a classifier screens each action and only escalates the risky ones. `full_auto` classifies nothing. A user who reads "Auto" and meets a refusal-free, question-free run has been told one thing and given another.

**The four lines have no boundary at all.** Inside what `fsMode` permits, `full_auto` is unbounded by design — that is the mode's purpose. Outside it, the call reaches the fence, the kernel refuses it, and the agent receives an EROFS line. That refusal is _correct_ (the mode's boundary did its job) but it is **unaskable**: the operator set `fsMode` themselves, so the harness cannot know whether this particular call crossing this particular boundary was intended, and the agent cannot try a narrower spelling because the boundary is a mount, not a rule. The result is a mode whose only boundary is a wall it never explains.

Meanwhile the network boundary already asks this exact question. A first-seen host is put to the user (`src/harness/sandbox/egress/approval.ts`), the answer is honoured, and the session continues. So the product already contains the behaviour `full_auto` lacks — on one axis, and not on the other. The asymmetry is the actual defect; the label is how it reached the user.

## Decision

**`full_auto` is bounded, and its boundary is a question rather than a wall.**

### 1. What the mode means

Inside what the current `fsMode` permits, `full_auto` asks nothing — unchanged, and that is the mode's value. When a call **leaves** what the current mode permits, the operator is asked **once about that call**: allow it this time, or refuse it. A refusal returns an actionable error to the agent, which is then free to try a narrower spelling, report the constraint, or move on.

**The answer decides the call, never the configuration.** Answering "yes" widens that call's reach; it does not write the `fsMode` holder, does not change a settings file, and does not persist. The operator's mode setting is theirs; a boundary crossing is a question about one call, and the product has no notion of a mode the operator did not choose.

**Both non-asking modes reach this question, not just `full_auto`.** This is the correction to the framing this ADR replaces: an out-of-boundary write is not a `full_auto` behaviour. `default` hits the same wall today and will now meet the same question — which is the honest shape, because the wall was never mode-specific.

**`plan` does not reach it.** `plan`'s refusal is a deny (`src/harness/permission/policy.ts`), and the boundary question is not a route to talk a read-only session into writing. Hard walls and the security review run **before** any of this and are unchanged; `full_auto` never reached them and does not now.

### 2. Where the question is asked, and how it reaches the operator

The boundary is decided **in the permission decision path**, where every other "does this call need the operator" question is already decided, and the answer travels the product's existing question route. Three properties make this the right location:

1. **The question is not a new mechanism.** The product already asks the operator about calls and already routes the answer back to the agent (`PermissionOutcome`'s `ask` branch, resolved by the executor's ask path). A boundary crossing is one more reason to ask, decided in the same place and carried by the same route. Nothing about a boundary needs an ask surface that does not already exist.
2. **The decision must be available before the call runs.** The operator's answer is only meaningful if it can widen _this_ call, which means the crossing has to be known before the fence assembles — not after the kernel has already refused it. The permission decision is where the call's command and the current `fsMode` are both in hand and nothing has executed yet.
3. **One authority for the boundary, not two.** ADR-0092 rejected implementing a boundary in both the fence's mount layer and the write-tool side, because "two implementations that can each drift". The prohibition is on duplication, not on deciding it in the permission layer: there is exactly one boundary decision, and the fence remains the thing that physically enforces it. An agent may still route around a _command-spelling_ filter through an interpreter (ADR-0129's finding); that is why the fence's protection stays and this decision is an additional, not a substitute, refusal source.

The boundary judgement reuses the product's existing command-and-path inspection (the same seam the protected-target matching already uses), extended to ask "is the write target inside what the current `fsMode` permits" in addition to "is it a protected target".

#### The two geometries, and which one the question asks about

"Outside what the tier permits" and "the fence would refuse this" are **not the same predicate**, and measuring the real fence settles which one is honest.

The workspace tier emits `--bind / /` and then ro-binds over it. The declared writable set is therefore a **whitelist overlay on a writable `/` substrate**, not the kernel's writable set: writes to `/tmp`, `/var/tmp` and `/dev/shm` land successfully while sitting outside the declaration. A question built on the declaration's complement would prompt the operator about crossings that were never going to be refused.

So the question is bound to the **refusal geometry** — the fence's read-only bindings: the system prefixes every tier re-binds (`/usr /bin /lib /lib64 /etc`, plus `/opt` and `/snap` when present), and `home` when the workspace tier `--ro-bind`s it. Both geometries are declared once, in `src/harness/sandbox/fs-boundary.ts`, and `isRefusedByFsBoundary` is the one the ask is built on.

Three consequences recorded here rather than discovered later:

1. **Answering yes does not widen the fence.** There is no per-call bind override in `bwrap.ts`, so approval means _the call is attempted_, not that it will succeed. The fence and the write tools' own root guards stay authoritative and may still refuse. The ask reason string says exactly this rather than claiming the answer widens reach.
2. **The write tools are narrower than the fence.** `write_file` / `edit_file` admit only `{taskRoot, own pad, session tmp}`, so an approved crossing on those tools is still refused by the tool's own guard. The gate's observable claim is the question, not the outcome.
3. **`cwdReadonly` is not modelled.** It is a per-call fence option the permission layer cannot see, so a write inside a declared reachable root that `cwdReadonly` re-binds read-only neither asks nor produces the `[fs_denied]` arm. Known exception, not an oversight.

**`bash` is not covered.** Its write target lives inside a shell command string rather than a declared path key, so `writeTargetOf` never resolves one and the question never fires for it. That is where a faithful extractor would have to come from — inside `hard-walls.ts`, which does not export one. Until that exists, `bash`'s out-of-reach write reaches the kernel and returns the `[fs_denied]` refusal below rather than a question.

### 3. The question is per-call, and deliberately unlike the network boundary

The network gate remembers: an approved host is allowed for the rest of the session. **The file-boundary question does not.** It is asked per crossing and its answer is not remembered, for two reasons: `fsMode` can change mid-session (a holder, flipped by `/config`), so a remembered answer would outlive the condition that justified it; and a remembered answer would convert a setting the operator chose into a grant they did not, which is the coupling ADR-0139 just removed from the other side of the axis. Approval is one call's answer.

**Fail-closed in every degraded case.** No ask surface (a headless entry) or a throwing ask surface refuses the crossing. The product never widens a boundary it could not ask about.

### 4. What the refusal says

A refusal reaches the agent through the same `[fs_denied]`-shaped channel that boundary refusals already use (`specs/effect-boundary-protection.md` owns that contract; this ADR does not re-define the prefix), carrying enough for the agent to act on: what was refused, and that the current mode's reach is what stopped it.

The wording is where this ADR intersects a live contract, and the intersection is deliberate: the existing template asserts that a protected target **"stays read-only for the whole session"**, which is true of a protected target (physical, unconditional, no route) and **false of a mode boundary** (answerable, per-call). A mode-boundary refusal therefore does not reuse that sentence — an agent receiving "this cannot be removed" about a file it could have been allowed to write will not try the narrower spelling, which is the whole point of the question. One prefix family, two arms, two truthful sentences. **Fixing the template is the first step of implementation, before any code moves** — the contract is in `specs/effect-boundary-protection.md` and that spec is amended first.

### 5. The label, and what `full_auto` is

The value keeps its name (`full_auto`); the UI label stays "Auto". The label becomes **earned**: the mode now has a boundary, a defined posture at that boundary, and a question at it. It is still not a classifier mode, and this ADR does not claim it is — `Auto` here means the operator has automated the decisions inside their chosen reach, not that the product is guessing on their behalf.

What this mode **is**, in the product's own terms: **the fence is the boundary, the operator is still reachable at its edge.** What it is not: unrestricted. Hard walls and the security review remain pre-filters; under yolo the mode does not touch the fence at all (ADR-0139), so the boundary is gone and so is the question — there is nothing to ask about, because nothing refused it.

## Consequences

- **Positive:** the mode's boundary becomes visible and negotiable instead of a wall the agent cannot interpret; `default` gains the same question at the same boundary, so the two modes differ in _when they ask_ rather than in what they do when they don't; the label matches the behaviour.
- **Negative / trade-offs:** a `full_auto` session can now be interrupted, which is the one thing its users were buying by choosing it. The trade is deliberate and bounded: interruptions occur only at the edge of the operator's own reach, which is exactly where a question carries information. Sessions with no `fsMode` boundary (global mode, or yolo) are not interrupted at all.
- The boundary is asked at the fence, so the question inherits the fence's route coverage — the same four routes (foreground bash / background spawn / verify sandbox-run / subagent worker) that ADR-0119's retirement applies to. A crossing on a route that never runs fenced has no boundary to cross.
- The egress gate keeps its session memory; the two gates are deliberately different and both differences are stated here rather than left to be read as drift.

## Evidence pointers

- The mode branch this ADR narrows: `src/harness/permission/policy.ts` (`full_auto` unconditional allow; the hard wall and security review above it, unchanged).
- The question route the boundary joins: the same file's `PermissionOutcome` `ask` decision, carried by `src/harness/permission/permission-executor.ts` (the ask path the executor already owns; the fail-closed construction-time guard when no ask surface exists).
- The command-and-path inspection the boundary judgement reuses: `src/harness/permission/hard-walls.ts` (the protected-target matching seam) and `src/harness/aci/tools/bash.ts` (the command/path form the fence is given).
- The refusal still stands where it does: `src/harness/sandbox/protected-target-feedback.ts` and `specs/effect-boundary-protection.md`, whose `[fs_denied]` channel reports the refusal when the answer is no.
- The shape this question does **not** copy: `src/harness/sandbox/egress/approval.ts` (session-level, remembered, `fail-closed`).
- The refusal contract and the sentence that must change: `specs/effect-boundary-protection.md`, `src/harness/sandbox/protected-target-feedback.ts`.
- The mode-boundary surface being crossed: `src/harness/sandbox/fs-mode.ts`, `src/harness/sandbox/fs-policy.ts`, and ADR-0092's Decision and rejected-options record.
- The project layer's standing refusal to grant this mode itself: `src/harness/permission/project-settings.ts`.
