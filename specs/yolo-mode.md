# Spec: yolo-mode — `--yolo` no-sandbox mode (issue #1035)

**Status:** ready for review (decision SSOT = ADR-0119, as amended by ADR-0139 on 2026-10-06)
**Surface:** `src/harness/sandbox/` (`bwrap.ts` factory yolo branch + yolo holder + `requireBwrap` pre-check in `runner.ts`), `src/harness/build-engine.ts` (holder assembly pass-through), `src/harness/aci/tools/bash.ts`, `src/harness/background/manager.ts`, `src/harness/verify/` (sandbox-run / verify-loop holder passing), `src/harness/subagent/` (parent-side env wire + worker read side), `src/cli/` (parse-args / cli dispatch / usage), `src/tui/` (slash + confirm modal + mode row), `tests/harness/sandbox/yolo-probe-parity.test.ts` (probe-parity pins, taking over the yolo category of the former `scripts/sandbox-probe.ts`)
**Plan:** `plans/yolo-mode.md` (ACR rev3 PASS); **Decisions:** `docs/adr/0119-yolo-no-sandbox-mode.md`

## Goal

Add a `--yolo` **no-sandbox mode** to the TUI: reachable only from the CLI entry before entering the TUI plus an in-session confirmation-switch; entering **retires the whole bwrap fence** (all four routes agree — foreground bash / background spawn / verify sandbox-run / subagent worker), `fsMode: workspace` is force-switched back to `global` first, and the mode row carries a persistent red marker; a non-TUI entry carrying the flag fails with a typed error and a non-zero exit.

**Semantic boundary (versus "sandbox still on, permissions loosened")**: yolo means the fence layer is absent wholesale, not that the permission layer relaxes.

> **Amended 2026-10-06 by ADR-0139 (operator ruling).** The original text continued: _"Setting permission to `full_auto` is an **entailed consequence** of the entry action … it is not the definition of yolo."_ **That clause is withdrawn.** Yolo's entry writes the fence axis only; the permission posture is a **separate, independently visible and independently reversible axis** and is not touched by entering or leaving yolo. The rest of the semantic boundary stands: the fence is absent wholesale, which is still not the same thing as relaxing the permission layer. The consequence worth stating plainly is that **"no fence" no longer implies "no questions"** — a yolo session in `default` asks per call, and ADR-0139 §2 names and defines that posture. The `--yolo` + `--auto-mode` combination cell in the input table below is therefore re-read: the two flags are now genuinely independent, so `--auto-mode` is the only thing that sets `full_auto`.

**Users:** the local operator (explicitly asking for "no sandbox = no fencing at all", with all four routes consistent) and the model (working under unfenced bash, with no bwrap prefix in argv).

## Boundaries

- **Does:**
  - Add a yolo branch to `createBwrapFence` (`src/harness/sandbox/bwrap.ts:377`, the shared SSOT single factory for all four routes): under yolo it produces bare argv (no bwrap prefix).
  - Add a **yolo holder** (mirroring the `FsModeContext` shape, living in `src/harness/sandbox/`); holder absent = non-yolo (fail-closed).
  - Enter / exit actions: `fsMode: workspace` to `global` / restore snapshot — **holder flips only, never rewriting user-layer settings**. **The permission holder is not written** (ADR-0139); yolo does not set, imply, or restore a permission posture.
  - Startup entry `--yolo` (TUI only; `src/cli/parse-args.ts` + `src/cli.ts` + `src/cli/usage.ts`); the five public non-TUI commands (`chat` / `serve` / `ask` / `oneshot` / `trace`) carrying it → typed parse-time error.
  - In-session `/yolo` + confirmation modal (entry always asks for confirmation; exit is immediate, no confirmation).
  - Persistent red YOLO marker on the mode row (reuses `pal.error`; no new token, no extra bottom-bar row).
  - **Symmetric `requireBwrap` probing on both entry and exit** (see Contract).
  - The probe-parity pins for the probe's yolo category live in `tests/harness/sandbox/yolo-probe-parity.test.ts` (the yolo checks formerly in `scripts/sandbox-probe.ts` moved here; the existing non-yolo assertions were **extended** conditionally, never inverted or deleted).
- **Does NOT (axes outside this spec, named one by one):**
  - The `network-guard` stack behind `web_fetch` / `web_search` (a separate line of defense).
  - The worktree gate (`worktreeOnMutate` / `src/harness/isolation/worktree-gate.ts`) — the two axes are orthogonal, yolo changes no gate semantics.
  - The hard wall (the wall intercepts first in **every** permission mode, whether or not yolo is on; yolo does not reach it).
  - The `PERMISSION_MODES` value domain (still three values; `full_auto` keeps its name, badge untouched).
  - Persistence (nothing in settings / session files / config-panel rows).
  - Half-bare operation (no second fence shape such as "foreground bare, background still fenced").

## Settled invariants

1. **The fence retires wholesale, this is not permission relaxation**: under yolo the spawn argv has no bwrap prefix, consistently across all four routes; the reading "sandbox still on but permissions relaxed" does not exist.
2. **Single SSOT point**: all four routes share one branch of `createBwrapFence`; there is no second fence assembly. A missing new `BwrapFenceOptions` field (`undefined`) = non-yolo.
3. **Zero change off yolo**: on paths that are neither yolo nor **评测态 (eval state)**, the argv, `requireBwrap` behavior, the always-present `--unshare-net`, and egress assembly are byte-identical (ADR-0097 is only named-amended, never revoked).
4. **TUI-only reachability**: the entries are the `--yolo` flag (before TUI start) and in-session `/yolo` + confirmation modal only; a non-TUI public command carrying it = typed error with non-zero exit.
5. **Nothing persisted**: the yolo axis stays out of settings, out of the session file, with no config-panel row; at startup each session passes it explicitly, in-session switching touches the in-memory holder only.
6. **Entry/exit are an idempotent set**: repeated entry takes no second snapshot, repeated exit overwrites nothing (guarding the snapshot against self-pollution); after one enter → exit → re-enter the snapshot still holds the true pre-entry values.
7. **Axis orthogonality**: yolo does not lock the permission axis (Shift+Tab still cycles) and **does not write it** (ADR-0139: entering yolo leaves the permission posture exactly as it was); yolo does not skip the worktree gate; the egress domain allowlist does not intervene under yolo.
8. **Symmetric probing + fail-closed**: on a host without bwrap, entry and exit are **refused alike** (typed notice + guidance, zero state change); holder absent defaults to non-yolo.
9. **Exemptions must be named**: yolo is the explicit exemption face of sandbox discipline #653 G3 and ADR-0097 invariant #1 (carried by ADR-0119's ruling; on the ADR-0097 side it is the Amendment 2026-09-18). **评测态 (eval state)** (ADR-0130) is a **second, separately named face** of those same two, reached headlessly by an explicit non-default opt-in — the invariant is that every face is named and greppable, not that exactly one exists. `--yolo` itself stays TUI-only (rule 4) and is not the door to eval state.

## Operator-locked specification (implementers no longer choose)

| Dimension  | Locked specification                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Naming     | `--yolo`; the `full_auto` field name and code face stay (this plan ruled: no rename)                                                                                                 |
| Entry      | `--yolo` before TUI start only (CLI argument); no silent in-session switch without confirmation                                                                                      |
| In-session | switching in is allowed but must raise the confirmation modal; exit is immediate                                                                                                     |
| Display    | red marker after entry, persistent, visible at a glance                                                                                                                              |
| Semantics  | no sandbox — not "sandbox still on with relaxed permissions"; on entry `fsMode: workspace` is force-switched back to `global` first; **the permission axis is untouched** (ADR-0139) |

## Contract (input / error contract, all bullets apply, taken line by line from `plans/yolo-mode.md`)

- **With yolo ON the mode row must contain a persistent red (`pal.error`) YOLO token**; how it coexists with the permission label is left to the implementation. With yolo OFF the existing mode-row shape (`Default / Plan / Auto / Graph`) is byte-identical.
- **yolo does not lock or write the permission axis**: Shift+Tab still cycles under yolo (orthogonal), and the permission posture at entry is whatever the session already had — the operator's `IKNOW_PERMISSION_MODE`, else the project `defaultMode`, else `default` (ADR-0139). Exit restores the `fsMode` snapshot; the permission holder has no yolo snapshot to restore, because yolo never wrote it.
- **The fsMode force-switch goes through the holder only, never rewriting user-layer settings** (aligned with ADR-0092 "runtime in-place flips go through the holder"); exit restores the snapshotted value.
- **Entry/exit actions are an idempotent set**: repeated entry takes no second snapshot, repeated exit overwrites nothing (guarding the snapshot against self-pollution).
- **A missing new `BwrapFenceOptions` field (undefined) = non-yolo**: argv byte-identical to today's (the V1 baseline tests not regressing is a hard constraint).
- **Zero change on the non-yolo path is this spec's overall regression contract**: every case in `tests/harness/sandbox/yolo-probe-parity.test.ts` plus all existing argv pin tests must not regress (the former `npm run probe:sandbox` matrix retired with `scripts/sandbox-probe.ts`, archived to `iknow-archive/scripts-probes/`; its six yolo-category checks moved one by one into the parity test above; the subagent probe face `npm run probe:sandbox:subagent` stays on master).
- Five boundary classes (fence factory yolo branch = public entry): empty (yolo field missing → non-yolo) / invalid (yolo not boolean → treated as `false`, fail-closed, no throw) / combination (yolo + workspace fsMode, or yolo + an egress spec passed in → **yolo wins**, egress has no effect) / concurrency (reading consistency across one wave — foreground per-call, background per-spawn, worker through the env wire's initial value; within one turn, a `/yolo` flip against calls in flight: foreground keeps the existing per-call snapshot semantics, background keeps per-spawn semantics, **no cross-route atomicity** — the same boundary class as an fsMode flip, pinned by tests) / exception (holder absent → non-yolo, fail-closed keeping the fence; a host without bwrap does not block assembly under yolo).
- **`requireBwrap` sequencing ruling**: `requireBwrap` is a **construction-time** probe of the bash factory (`src/harness/aci/tools/bash.ts:779` → `src/harness/sandbox/runner.ts:306`). At assembly time the yolo holder's **initial value** decides whether it is called (the yolo assembly path skips it); **entry and exit probe symmetrically** — on a host without bwrap, `/yolo` entry is refused (typed error with install guidance), and a session that started in yolo is refused at exit on such a host too (notice with "install bwrap or quit the TUI" guidance) — it does **not** exit silently and turn every bash call into a runtime failure. Rationale: with no usable non-yolo fence, refusing is the only honest fail-closed. The non-yolo path's `requireBwrap` behavior is byte-identical.
- **Runtime failure surface under yolo (scoped)**: under yolo **no route assembles a fence at runtime** (the factory head retires it), so "bwrap disappears after entry" has no fence-assembly face inside a yolo session; the only face that re-assembles a fence is **exit**, which probes bwrap symmetrically (preceding clause), so a session cannot leave yolo on a bwrap-less host. The generic `server_unreachable` plain object (`src/harness/sandbox/server/index.ts`) → generic `"tool execution failed"` (`src/harness/tools/executor.ts`) surface that this clause originally demanded a typed upgrade for is **pre-existing non-yolo behavior**, byte-pinned by the zero-change regression contract above — a typed upgrade there is explicitly **out of scope** for this spec (it would mutate the non-yolo error bytes the contract protects).
- **typed-error catch contract** (`.claude/rules/code-quality.md`): the non-TUI entry's `--yolo` error goes through the typed discriminated union (`kind`), rendered `${kind}: ...`; `err instanceof Error ? err.message : String(err)` is **forbidden** (a plain object would print as `[object Object]`, hiding `kind` / `context` entirely).

## Input contract table (five boundary classes)

Surface = **the fence factory's yolo branch** (public entry; all four routes through the same factory).

| Surface                       | empty                                                            | invalid                                                                                                                       | combination                                                                                                                                                                         | concurrent                                                                                                                                                                                | exception                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BwrapFenceOptions` yolo axis | yolo field missing → **non-yolo** (argv byte-identical to today) | yolo not boolean → treated as `false`, **fail-closed, no throw**                                                              | yolo + workspace fsMode → yolo wins, fsMode does not affect argv (once the fence retires the tier has nothing to carry it); yolo + egress spec passed in → **egress has no effect** | readings consistent across one wave (foreground per-call / background per-spawn / worker via env-wire initial value); a mid-turn flip against in-flight calls is not atomic across routes | holder absent → non-yolo (fail-closed, fence kept); a host without bwrap **does not block** assembly under yolo                                              |
| CLI `--yolo` (entry axis)     | no `--yolo` → every entry byte-identical to today                | non-TUI entry (`chat` / `serve` / `ask` / `oneshot` / `trace`) carrying it → **typed error + non-zero exit, nothing started** | `--yolo` together with `--auto-mode` are **independent** (ADR-0139): `--yolo` sets the fence axis, `--auto-mode` sets `full_auto`, neither sets the other                           | N/A                                                                                                                                                                                       | `-h` / `--help` / `-V` / `--version` / bare `--yolo` (no subcommand) → the handling must be explicitly declared (allowed or refused; no undeclared behavior) |
| In-session `/yolo` (TUI axis) | N/A                                                              | modal cancelled / Esc → zero state change                                                                                     | `/yolo` again while yolo ON takes the exit path, **going through the bwrap probe as well**                                                                                          | modal exclusivity against the other pickers / ask follows the existing precedent                                                                                                          | host without bwrap → entry **and** exit both refused (typed notice + guidance, zero TUI state change, session continues)                                     |

## EXIT

- Non-TUI `--yolo` (`chat` / `serve` / `ask` / `oneshot` / `trace`) → **the process exits non-zero, nothing starts**; the error renders through the typed discriminated union (`kind` readable, guidance in the copy) as `${kind}: ...`.
- `/yolo` **entry or exit refused** on a host without bwrap → **zero TUI state change + notice**, session continues (no crash, no quit).
- bwrap disappears during a yolo session → **nothing observable on the bash routes** (none of them invokes bwrap while yolo is on); the following `/yolo` exit is refused per the `requireBwrap` sequencing clause, so the session never drops into a fenced shape it cannot assemble. The generic non-yolo failure surface is out of scope (Contract §"Runtime failure surface under yolo").
- Handling of `-h` / `--version` / bare `--yolo` with yolo ON/OFF: **either allow the pure display path (exit 0, no session start) or refuse it too — one of the two, never an undeclared behavior** (declared explicitly during implementation; ACR rev3 observation ②).

## Out of scope

- The `network-guard` stack behind `web_fetch` / `web_search` — a separate line of defense, unaffected by this spec (same declaration as `specs/network-egress-allowlist.md`).
- The worktree gate (`worktreeOnMutate`) — the two axes are orthogonal, this spec changes neither.
- The hard wall and the three-layer permission chain — the wall intercepts first in every mode; yolo reaches neither the wall nor the permission axis (ADR-0139). What `full_auto` itself means is ADR-0140's subject, not this spec's.
- Widening the `PERMISSION_MODES` domain / renaming `full_auto` / touching its badge.
- Any persistence shape of the yolo state (settings key, session field, config-panel row).
- A half-bare shape (foreground bare, background still fenced) — **explicitly rejected**, it would create a second fence shape.
- Content-level control / TLS termination / reverse reachability (each within ADR-0072 and ADR-0097's own scope).
- Any substitute for the network boundary: with yolo there is **no egress boundary at all**, and it must never be described as "controlled".

## Inherits / Changes

- **Inherits**: the `createBwrapFence` single factory plus argv-order discipline (`.claude/rules/security-boundaries.md` "Sandbox argv"); the `FsModeContext` holder shape and the "flip in place at runtime, no engine rebuild" discipline (ADR-0092); the `--auto-mode` flag-channel precedent (`src/cli/parse-args.ts` → `src/cli.ts`, though its **silently ignored** handling is not adopted); the `BWRAP_PATTERNS` test face and the three-way `vitest.ci-excludes.ts` check (`scripts/ci-check-test-excludes.ts`); `pal.error` (`src/tui/theme.ts:87`) and the `chromeReserveRows` row accounting (`src/tui/app.tsx`).
- **Changes**: ADR-0097 gains the **Amendment 2026-09-18** (yolo is the explicit exemption face of its invariant #1, not a supersede); `docs/CONTEXT.md` adds the "yolo mode" entry, an exception line to sandbox discipline #653, and four orthogonal pairs in Relationships; ADR-0119 carries the eight-question rulings and resolves the two conflicts.
- **Amended 2026-10-06 by ADR-0139 (operator ruling)**: the eight sites that asserted the entry writes the permission axis — Goal, the semantic-boundary clause, the enter/exit action bullet, the hard-wall exclusion, invariant 7, the Semantics row of the lock table, the permission-axis contract line, and the input table's `--yolo` + `--auto-mode` cell — now state that yolo writes the fence axis only. The operator-locked five-dimension table is preserved row for row; the Semantics row's new clause is the ruling, not a re-opening of a locked choice. ADR-0139 §2 names the newly-reachable no-fence-with-questions posture; `specs/permission-axis-semantics.md` is the axis SSOT.
- **Registration**: this spec is registered in `specs/README.md` under the "Runtime core / sandbox" topic group (one-line responsibility + ADR-0119 pointer). (Historical note: `specs/README.md` was absent while this spec was written and the registration mechanism was noted in place; that index is back as this repository's live-spec SSOT, and this line registers under the restored mechanism.)

## Evidence pointers

- Plan and rulings: `plans/yolo-mode.md` (five-dimension lock table / eight-question ruling table / Contract / conflict record / per-task Acceptance); `docs/adr/0119-yolo-no-sandbox-mode.md`.
- Factory and four routes: `src/harness/sandbox/bwrap.ts:377` (SSOT factory `createBwrapFence`), `:82` (`egress` field), `:264-268` (comment on `--unshare-net` always present); assembly points `src/harness/aci/tools/bash.ts:424`, `src/harness/background/manager.ts:374`, `src/harness/verify/sandbox-run.ts:176`; the worker through `src/harness/aci/tools/registry.ts` (`yoloHolderSpread` pass-through) + `src/harness/subagent/worker.ts` (`IKNOW_YOLO` read side).
- Construction-time probe: `src/harness/aci/tools/bash.ts:779` → `src/harness/sandbox/runner.ts:306` (`requireBwrap`).
- Permission value domain: `src/harness/permission/modes.ts:28` (three values).
- Gate: `src/harness/isolation/worktree-gate.ts` (`isolation.worktreeOnMutate`, read once per wave).
- Display slots: `src/tui/app.tsx` (mode row via `modeRowBaseLabel` / `modeRowYoloMarker`, `src/tui/app.tsx:614/633`), `src/tui/app.tsx` (`chromeReserveRows` row accounting), `src/tui/theme.ts:87` (`pal.error`).
- Entry enumeration: `src/cli/parse-args.ts` (the `--yolo` typed refusal for the five public commands); `src/cli.ts:700-716` (non-TUI refusal dispatch, single reading point).
- Degradation-chain anchors: `src/harness/sandbox/server/index.ts` (plain `{kind,context,cause}`, `kind: "server_unreachable"`), `src/harness/tools/executor.ts:461` (`"tool execution failed"`).
- Adjacent spec: `specs/network-egress-allowlist.md` "Out of this spec" already excludes `--yolo` from its scope (separate ticket #1035, the two axes orthogonal).
