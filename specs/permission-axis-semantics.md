# Spec: Permission-axis semantics — what each axis controls, and what every combination means

**Status:** draft
**Basis:** ADR-0139 (the permission axis is fence-independent) / ADR-0140 (`full_auto` is bounded) / ADR-0119 (yolo; amended) / ADR-0092 (fs isolation modes) / ADR-0032 (the product word "auto mode" is `full_auto`) / ADR-0030 (graph overlay) / ADR-0068 (hard wall) / ADR-0127 (security review) / ADR-0090 (project-layer rule)

**Why this spec exists:** the permission axis had no home. Its three values were defined by a file-header comment (`src/harness/permission/modes.ts`) and about a dozen ADRs between them, and the two facts that mattered most — that yolo drives it (ADR-0119) and that `full_auto` is unbounded (`policy.ts`) — were carried by prose that no single place owned. Three ADRs had to be read together to answer "what does `full_auto` actually do", and reading them together produced a contradiction after 2026-10-06: ADR-0119 said entering yolo writes `full_auto`, while ADR-0140 describes a `full_auto` with a boundary question that only exists when the fence is up. This spec is the single answer, and it is where the next change lands.

---

## The two axes

The product has two independent runtime axes that both shape what a call may do. Neither writes the other (ADR-0139).

**The fence axis** — `fsMode` (global / workspace) plus the yolo boolean. It answers: _what is the process physically contained by?_ A fence is a mount-and-netns construction (`src/harness/sandbox/bwrap.ts`); yolo retires it wholesale, for all four routes, at one factory branch.

**The permission axis** — `PermissionMode` (`default` / `plan` / `full_auto`). It answers: _is this call put to the operator?_ It has three values and no fourth — the domain is closed at `src/harness/permission/modes.ts`.

Two things sit **beneath** both axes and are not axes:

- **Hard walls** (`src/harness/permission/hard-walls.ts`) — pre-execution, spelling-sensitive denials that no mode, grant, or fence setting overrides.
- **Security review** (ADR-0127) — the ambiguity channel for what the parser cannot decide; it asks even where a mode would allow.

---

## The fence axis

| Value                                                  | Meaning                                                                                                                                | Entered by                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **global**                                             | Host real paths readable and writable below the physically protected targets.                                                          | default; `/config fs global`                    |
| **workspace**                                          | Home visible but read-only; writes are the live `taskRoot` ∪ session tmp. A write outside that is refused by the mount, not by a rule. | `/config fs workspace`                          |
| **yolo ON** (with either `fsMode`, forced to `global`) | The fence retires entirely: bare argv, no mount layers, no netns, no egress seam. All four routes run bare.                            | `--yolo` before the TUI; `/yolo` + confirmation |

The `fsMode` value and the yolo boolean are **not one setting**: yolo's entry forces `fsMode → global` because a workspace tier has no fence to carry it, and exit restores the snapshot.

---

## The permission axis

| Value           | Read-only calls | Mutating calls                                                                                | Label     |
| --------------- | --------------- | --------------------------------------------------------------------------------------------- | --------- |
| **`default`**   | allow           | **ask** (the operator decides per call)                                                       | Default   |
| **`plan`**      | allow           | **deny, without asking**                                                                      | Plan Mode |
| **`full_auto`** | allow           | allow **inside the current `fsMode`'s reach**; **at the edge of it, one question** (ADR-0140) | Auto      |

`plan` is deliberately not a Shift+Tab wheel station: a planning session must not be flushed by a stray keypress. It is entered and left by explicit command, from every surface that offers a mode switch.

---

## The combinations

This is the section the missing spec existed for. Every reachable posture:

| #   | Fence          | Mode        | Behaviour at the edge                     | What it is for                                                                                                                                                                                                                                                    |
| --- | -------------- | ----------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | on             | `default`   | ask                                       | The daily posture. Fence contains mistakes; the operator decides intent.                                                                                                                                                                                          |
| 2   | on             | `plan`      | deny (no question)                        | Read-only investigation. The agent explores and reports; it cannot write at all.                                                                                                                                                                                  |
| 3   | on             | `full_auto` | ask **once about the crossing**, per call | Automated work inside the operator's chosen reach; the operator stays reachable at its edge (ADR-0140).                                                                                                                                                           |
| 4   | **off** (yolo) | `default`   | ask                                       | **Named by ADR-0139 §2.** Every call put to the operator; no fence to contain a mistake between answers. Not the safer choice — it removes a boundary and keeps a process. For environments that already provide containment, and for diagnosing fence behaviour. |
| 5   | **off** (yolo) | `plan`      | n/a (nothing writes)                      | Read-only with no fence — the fence's restrictions do not shape what the agent may attempt.                                                                                                                                                                       |
| 6   | **off** (yolo) | `full_auto` | n/a (no boundary to cross)                | The maximally automated posture: no questions, no fence. ADR-0130's eval state runs here, entered headlessly under its own name.                                                                                                                                  |

Posture 4 is the one that was unreachable before 2026-10-06 and unnamed until ADR-0139 §2 gave it a name.

---

## Does

- **Own the definition of each mode's behaviour** in one place, so that a change to `full_auto` semantics is a change here first.
- **Name every reachable combination.** An unnamed reachable posture is the failure mode that produced the original coupling.
- **Record the boundary question's home** — the permission decision path, where every other "does this call need the operator" question is already decided and where the existing ask route carries the answer. There is **one** boundary decision: the fence still physically enforces the mode's reach (ADR-0092 rejects duplicating a boundary across layers, not deciding it before the call runs), and this decision is an additional refusal source, not a substitute for the fence. The decision must be available **before** the call executes — an answer that arrives after the kernel has already refused cannot widen that call.
- **Distinguish the two refusals** a `[fs_denied]`-shaped message can carry:
  - a **protected-target** refusal (physical, unconditional, no route — `specs/effect-boundary-protection.md`'s contract), and
  - a **mode-boundary** refusal (this call left the current `fsMode`'s reach — **answerable**, per ADR-0140).
    They share the `[fs_denied]` prefix family and **must not share a sentence**: a permanent-sounding refusal about a temporary condition tells the agent there is no narrower spelling to try, which is the one thing it needs to know.
- **Record the two gates' deliberate differences** from the egress side: the network gate remembers a decision for the session; the file-boundary gate does not, because `fsMode` is a mid-session holder and a remembered answer would outlive its condition (ADR-0140 §3).

## Does not

- **Change the mode domain.** Three values, `full_auto` keeps its name (`src/harness/permission/modes.ts`; ADR-0119's non-goal list carries this forward). A fourth mode is tracked separately (issue #1214).
- **Change what the hard wall or the security review do.** They are below both axes and stay there.
- **Change yolo's entry enumeration, its non-persistence, or its no-half-bare rule.** ADR-0119's rulings 2, 7 and 8 stand verbatim; ADR-0139 amended ruling 1 and Amendment (ii) only.
- **Define the protected-target inventory** — `specs/effect-boundary-protection.md` owns it.
- **Grant the project layer the ability to set `defaultMode: "full_auto"`** — ADR-0090's fail-loud stands.

---

## Consistency surfaces (a change here lands in all of them)

- `src/harness/permission/modes.ts` — the value domain, `modeLabel`, the Shift+Tab cycle and its non-cycle ruling for `plan`.
- `src/harness/permission/policy.ts` — the mode branch of the decision, beneath the hard wall and security review.
- `src/harness/sandbox/yolo.ts` — the fence-axis entry; ADR-0139 removed its permission write.
- `src/harness/aci/tools` — the boundary question and the two `[fs_denied]` arms.
- `src/harness/sandbox/egress/approval.ts` — the other gate, deliberately shaped differently; listed so the difference is a decision on record rather than a drift discovered later.
- `docs/CONTEXT.md` — the 自动模式 / yolo 模式 / 评测态 entries, and the Relationships note on the two axes.
- Every user-facing surface that names a mode or reports a refusal: TUI mode row, REPL `/permissions`, the yolo confirmation copy and its exit notice, web composer.

## Open questions

None blocking. One carried forward for a future decision, not for this spec:

- **Whether `full_auto`'s boundary question belongs on the same session-level footing as the egress gate after all.** ADR-0140 chose per-call, on the grounds that `fsMode` is a mid-session holder. If the holder is ever frozen for a session, the argument weakens and a remembered answer becomes defensible. Recorded so a later change is a decision rather than a drift.
