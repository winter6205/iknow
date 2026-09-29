# 0119. `--yolo` no-sandbox mode: the fence retires entirely (the single explicit, operator-locked counter-example)

Date: 2026-09-18
Status: accepted
Deciders: operator (issue #1035 ballot: the locked five-dimension spec + the eight-question list)
Related: ADR-0092 (precedent: runtime in-place holder flips), ADR-0097 (this mode is the explicit exemption face of its invariant #1), ADR-0037 / ADR-0096 (the worktree-gate axis, orthogonal), ADR-0109 (the in-fence main-checkout ro-bind rides the exemption; the which-tree axis does not), ADR-0084 (user-layer settings discipline)

Adds `--yolo`: a **no-sandbox mode** — the bwrap fence retires entirely and all four routes (foreground bash / background spawn / verify sandbox-run / subagent worker) run bare; the permission face becomes `full_auto`, `fsMode: workspace` is forced back to `global` on entry; the mode row carries a persistent red marker. There are exactly two entry points: the CLI flag `--yolo` before entering the TUI, and in-session `/yolo` + a confirmation modal. Non-TUI entries carrying `--yolo` fail with a typed error and a non-zero exit. The state is not persisted.

Spec: `specs/yolo-mode.md` (operator-locked five-dimension table + input contract + EXIT).

## Context

The ballot itself is the operator-locked spec: issue #1035's open item #2 already set the direction — **run fully bare**, with YOLO as its explicit counter-example. This collides head-on with two standing clauses, which this ADR adjudicates in one place:

- `docs/CONTEXT.md` "sandbox discipline": "the product path **must not** offer an unfenced bare background run".
- ADR-0097 Decision: "`--unshare-net` becomes a **permanent item** (never removed by any path)" / its spec's Settled invariant #1 "there is no second exit and no escape hatch" (the landing comment + flag in `src/harness/sandbox/bwrap.ts` are that invariant's physical form).

Neither reopening is "the judgment went stale"; both are **adding one named exemption face**: the operator explicitly demands "no sandbox = no fencing at all", and demands it consistently across the four routes. This ADR's product is the shape and the boundaries of that exemption face.

## Decision

**yolo is not "sandbox stays but permission lets through" — the fence retires as a whole.** The landing shape is the yolo branch of the single SSOT factory: `createBwrapFence` (`src/harness/sandbox/bwrap.ts`) emits a bare argv under yolo (no bwrap prefix), so all four routes inherit it transparently; there is no "foreground-only" half-bare mode (that would create a second fence shape).

Entry action = a state combination: permission set to `full_auto` + `fsMode: workspace` switched to `global` (both **flip holders only, never rewrite user-layer settings**, aligned with ADR-0092 "runtime in-place flips go through the holder"); exit action = restore the pre-entry snapshot, immediately, without confirmation. A `runTui --yolo` startup carries the same entry contract: the session must be entered **through the enter action** (permission → `full_auto`, fsMode → `global`), not merely a display seed — the startup path applies the same state combination that `/yolo` confirmation applies.

The per-clause shape of the operator-locked five dimensions (naming / entry / in-session switch / display / semantics) and the input contract lives in `specs/yolo-mode.md`; this ADR locks only the rulings and their basis.

## Rulings (the eight questions, recorded item by item)

### 1. Relation to `full_auto`: an independent boolean state axis, not a fourth `PermissionMode`

yolo is an **independent boolean state axis** (mirroring the `FsModeContext` holder shape), **not** a fourth `PermissionMode`; `full_auto` keeps its name, the value domain / badges / `PermissionModeContext` face are untouched. Entering yolo **implies** setting the permission holder to `full_auto` (reusing existing semantics, hard-wall pre-filters included).

**Basis:** `PERMISSION_MODES` three values (`src/harness/permission/modes.ts:28`); the Shift+Tab three-state cycle stays; the blast radius of renaming (or squeezing yolo into the value domain) — settings value domain / fail-loud validation / `docs/CONTEXT.md` / all tests — far outweighs the gain. The orthogonality of the two axes is also what guarantees Shift+Tab still works under yolo (see the contract).

### 2. The physical boundary of no-sandbox: all four routes bare, landing on the single factory

**All four routes run bare**: foreground bash / background spawn / verify sandbox-run / subagent worker. Landing shape = the yolo branch of `createBwrapFence` (`src/harness/sandbox/bwrap.ts`); the four routes inherit it transparently. No "foreground-only" half-bare mode.

**Basis:** the assembly points all call the same factory (`src/harness/aci/tools/bash.ts` / `src/harness/background/manager.ts` / `src/harness/verify/sandbox-run.ts`); the subagent worker reaches the same `createBashTool` via the registry. One branch at the factory covers four routes — that is the reason for branching at the factory rather than at the call sites.

**Wire hygiene (post-review amendment):** the subagent-worker `IKNOW_YOLO` env wire is normalized parent-side — holder wired → `"1"` / `"0"` both written (same discipline as `IKNOW_WORKTREE_GATE_ON`), and an inherited ambient `IKNOW_YOLO` is always scrubbed from the child env — so a stray host value can never retire a worker's fence under a non-yolo parent (fail-closed).

### 3. Relation to the network axis: the egress seam is skipped wholesale

Under yolo the **egress seam is skipped wholesale** (no unix socket bind, no proxy env injection): no fence = no netns → the network is naturally wide open and the domain allowlist does not intervene. Non-yolo keeps egress as-is (ADR-0097 unchanged); **yolo is its explicit exemption face** (the Amendment lives in the ADR-0097 file).

**Basis:** `egress` is a `BwrapFenceOptions` field; `specs/network-egress-allowlist.md` "Out of this spec" already carves `--yolo` out of that spec's scope (the two axes are orthogonal; the exemption is adjudicated here).

### 4. Relation to the worktree gate: not skipped

**Not skipped.** The gate manages "which tree receives writes"; the fence manages "whether a process can escape the sandbox" — two orthogonal axes, and yolo changes no gate semantics.

**Basis:** `src/harness/isolation/worktree-gate.ts` (read once per wave, never mid-wave); the orthogonality declaration lives in the `docs/CONTEXT.md` Relationships section ("filesystem isolation tier vs worktree isolation mode"); ADR-0037 states the two axes are orthogonal.

### 5. Red display placement: the mode-row badge slot, no new bottom-bar row

With yolo ON the **mode row** carries the red YOLO text (reusing `pal.error`, `src/tui/theme.ts:87`); no new bottom-bar row.

**Basis:** the mode-row render site in `src/tui/app.tsx`; the `chromeReserveRows` line accounting — riding an existing row makes the row cost zero; `pal.error` red precedent (`src/tui/context-bar.tsx` `contextColor`).

### 6. Exit path: re-entering `/yolo` exits, restoring the snapshot

In a TUI session, `/yolo` re-entry exits (**no confirmation** — the asymmetry with entry is deliberate: exiting is always safe); permission / fsMode restore the pre-entry snapshot. A session that started yolo (`--yolo`) lands back on `default` / project `plan` after exit (snapshot = the startup initial values).

**Basis:** snapshot restore = least astonishment; user-layer settings are never rewritten (ADR-0084 discipline); entry and exit are both idempotent sets (re-entry does not snapshot twice; repeated exits do not overwrite).

### 7. Non-interactive entries: TUI only; the five other public commands fail at parse with a typed error

**TUI only.** `chat` / `serve` / `ask` / `oneshot` / `trace` carrying `--yolo` → a parse-time **typed error** (not a silent ignore); the `__subagent_worker__` early-return path does not count as an entry, only the parent agent triggers it.

**Basis:** operator lock "only before entering the TUI"; the `--auto-mode` silent-ignore precedent (`src/cli.ts`) is **not adopted** — a dangerous flag silently swallowed is worse than a typed error; `trace` is an independent public branch in `src/cli/parse-args.ts` and must appear in the entry enumeration.

### 8. Persistence: none

**Not persisted**: never enters settings, never enters session files, no config-panel row. Startup `--yolo` is supplied per session explicitly; in-session switches are memory-holder only.

**Basis:** permission / fsMode / graph / worktree are all pure-holder precedents (reseeded from settings or defaults on restart).

## Conflict resolutions (two, both named)

**(a) `docs/CONTEXT.md` "sandbox discipline"** — the absoluteness of "the product path must not offer an unfenced bare background run" is **named-exempted exactly once** by this ADR: yolo is the **only** explicit, operator-locked counter-example; the discipline itself (the same `bash` input → foreground and `background:true` share one fence parameter set) remains word-for-word effective on non-yolo paths. **Relation = amend (the entry gains an exception line pointing here), not supersede** — the discipline is not overturned, only annotated with one named exemption face. The entry revision lives in `docs/CONTEXT.md` ("sandbox discipline" + the new "yolo mode" entry).

**(b) ADR-0097 Settled invariant #1** (`--unshare-net` permanent, no second exit, no escape hatch) — yolo is an **explicit exemption face, not a silent override**: under yolo the fence retires wholesale, `--unshare-net` disappears with the rest of the flags, and the egress seam has nothing to carry (no socket bind, no proxy env). **Relation = Amendment 2026-09-18 (appended to ADR-0097), not supersede** — on non-yolo paths the permanence, sole-egress property, and byte-for-byte argv shape of `--unshare-net` all hold; every other clause of ADR-0097 (domain allowlist, approval flow, address guard, socat prerequisite) stands.

The common shape of both resolutions: **an exemption must be explicit, named, and greppable to a pointer**, never "a conditional branch silently in force" (that is precisely what the `--unshare-net` landing comment "No conditional, no escape hatch" guards against — yolo is that hatch's **explicit named version**, not it smuggled back in).

## Amendment 2026-09-20 (rebase onto master)

**(i) The unboundFence / ro-bind exemption (the two-axis distinction).** Master added ADR-0109's physical guarantee: the unbound worktree-gate tier appends `--ro-bind <mainCheckout> <mainCheckout>` **inside** the fence. yolo removes the entire fence, so that in-fence guarantee is part of the yolo exemption by construction — the factory early-returns to the bare argv **before** any mount assembly (`createBwrapFence`, the `opts.yolo === true` branch in `src/harness/sandbox/bwrap.ts`). Two axes are distinguished: the **ro-bind axis** (the in-fence physical read-only overlay of the main checkout) is **exempt, riding the fence** — its carrier is gone; the **which-tree axis** (which checkout receives writes — the worktree binding / re-bind machinery) is **NOT exempt** — it is fence-independent and its semantics are unchanged (tool calls still resolve against the live `taskRoot`; ADR-0119 ruling 4 stands). What changes is only the enforcement layer: physical EROFS → none. The same exemption sentence is recorded in ADR-0097's Amendment.

**(ii) Startup enter semantics.** `runTui --yolo` **applies the enter action** — permission holder → `full_auto`, fsMode holder → `global` (the same state combination as the `/yolo` confirmation path) — not merely a display seed. The holder's initial value and the permission/fsMode combination are one contract: a session that displays YOLO must also behave YOLO from its first tool call.

**(iii) The regression face moved.** The physical probe `npm run probe:sandbox` no longer exists on master (archived to `iknow-archive/scripts-probes/`; the main repo keeps `probe:sandbox:subagent` for the violation face). The yolo argv-contract regression now lives in the vitest parity test `tests/harness/sandbox/yolo-probe-parity.test.ts`, which asserts against real `createBwrapFence` output and carries over the probe's six yolo checks (argv / same-netns / loopback / home-write / verify-route / fence-contrast), physically-executing arms guarded by the bwrap-availability convention.

## Amendment 2026-09-29 (eval state)

**Ruling 7 is qualified, not overturned.** `--yolo` remains a parse-time typed refusal on `chat` / `serve` / `ask` / `oneshot` / `trace` (`src/harness/sandbox/yolo.ts:79`), and yolo still has exactly two entry points. ADR-0130 adds a separate named posture — **eval state** — which reuses this ADR's entry state-combination verbatim (permission → `full_auto`, `fsMode: workspace` → `global`, fence retires wholesale, egress seam retired, all four routes bare) but is reached headlessly through an explicit, non-default, named opt-in. Basis: benchmark evaluation has no use for the fence, and invariant #1's constant `--unshare-net` would make install-dependent tasks structurally unsolvable for reasons unrelated to the model, destroying the score's attribution.

Three consequences for this document's own wording:

- Consequences' line "demoted from an absolute discipline to 'discipline + one named exception'" now describes **two named exceptions**: yolo mode (this ADR) and eval state (ADR-0130 §1).
- The defense line this ruling relied on — entry enumeration plus the parity tests — holds against what it was written to prevent, a _silent_ extension. Because eval state is a distinct face rather than a widened flag, `--yolo` keeps its TUI-only meaning and the byte-pinned refusal face certified by `tests/harness/sandbox/yolo-probe-parity.test.ts` is untouched. The narrowing is real but bounded: the defense now covers two named entries, and the ADR-0130 reporting invariant (an eval-state number must name its state) is the substitute audit face.
- The title's "the single explicit, operator-locked counter-example" and Conflict resolution (a)'s "named-exempted exactly once by this ADR … yolo is the **only** explicit, operator-locked counter-example" (`:83`) stay verbatim as the record of what this ADR did, and are qualified here: there are now **two** named counter-examples to `沙箱纪律` #653 G3 / ADR-0097 invariant #1 — yolo mode and **评测态** (ADR-0130). What still holds in both sentences is their scoping, not their count: one ADR named one face, and that face has exactly two entries.

What eval state does **not** exempt is unchanged by this amendment: the **hard-wall** still intercepts before `full_auto` grants anything, and the which-tree axis from Amendment (i) is fence-independent, so writes still resolve against the live `taskRoot`. The ro-bind axis and the credential read mask retire with the fence, exactly as under yolo — see ADR-0130 §3 for the consequence that follows for credentials injected into benchmark containers.

## Deletion / non-goals

**Out of this decision's scope** (named item by item, so later implementations cannot casually extend it):

- The `web_fetch` / `web_search` **network-guard stack** — a different defense line; yolo does not touch it (same declaration as `specs/network-egress-allowlist.md` "Out of scope").
- **The worktree gate** (`worktreeOnMutate` / `src/harness/isolation/worktree-gate.ts`) — orthogonal axes; yolo neither changes gate semantics nor skips it.
- **The hard wall** — entering yolo implies `full_auto`, the hard wall still pre-filters (ADR-0068 / ADR-0090 unchanged).
- **The `PERMISSION_MODES` value domain** — still three values (`src/harness/permission/modes.ts:28`); no fourth value, `full_auto` keeps its name.
- **No persistence** — never enters settings / session files / config-panel rows (ruling 8).
- **No unconfirmed silent in-session switch** — in-session entry must pass the confirmation modal.
- **No half-bare mode** — there is no "foreground bare + background still fenced" second fence shape (ruling 2).
- **ADR-0097 is not revoked** — egress works as usual on non-yolo paths.

## Consequences

**Positive / Applied:**

- Four-route consistent bare execution is realized by a **single SSOT branch** (`createBwrapFence`); no second fence assembly exists; the new `BwrapFenceOptions.yolo` field being absent (`undefined`) = non-yolo, argv byte-identical to before.
- The exemption face stays auditable: the yolo argv checks are certified by `tests/harness/sandbox/yolo-probe-parity.test.ts` against real factory output (see Amendment (iii) for the probe disposition).

**Negative / Trade-offs:**

- "no unfenced bare run" is demoted from an absolute discipline to "discipline + one named exception"; the moment the exception is copied or silently extended to non-TUI entries, the discipline is dead — the defense line is the entry enumeration (typed errors on the five public commands) + the parity tests, not the wording.
- Without netns the domain allowlist does not intervene: a yolo session's egress has **no boundary at all**. This is the cost the operator accepted; copy and docs must never phrase it as "controlled".
- Host-without-bwrap races are first-class citizens: symmetric probes on both enter and exit sides (refuse entry/exit when bwrap is gone); the residual race has no fence-assembly face under yolo (no route invokes bwrap mid-session) and the generic non-yolo failure surface stays byte-pinned out of scope (see `specs/yolo-mode.md` Contract §"Runtime failure surface under yolo").

## Evidence pointers

- Factory and argv: `src/harness/sandbox/bwrap.ts` (`createBwrapFence`; the yolo early return; the `--unshare-net` "No conditional, no escape hatch" comment), the `egress` / `yolo` fields of `BwrapFenceOptions`.
- Four assembly points: `src/harness/aci/tools/bash.ts`, `src/harness/background/manager.ts`, `src/harness/verify/sandbox-run.ts`; the subagent worker reaches the same `createBashTool` via `src/harness/aci/tools/registry.ts`.
- Construction-time probe: `requireBwrap` (`src/harness/sandbox/runner.ts`), called from the bash tool assembly.
- Permission value domain: `src/harness/permission/modes.ts:28`.
- Gate orthogonality: `src/harness/isolation/worktree-gate.ts`.
- Display slot: the mode row + `chromeReserveRows` accounting in `src/tui/app.tsx`; `pal.error` at `src/tui/theme.ts:87`.
- Non-TUI entry enumeration: the `chat` / `serve` / `trace` / `ask` / `oneshot` public branches in `src/cli/parse-args.ts`; the `--auto-mode` silent-ignore precedent in `src/cli.ts` (explicitly not adopted).
- Regression face: `tests/harness/sandbox/yolo-probe-parity.test.ts` (the archived physical probe per Amendment (iii)).
- Adjacent decisions: ADR-0097 (this mode is the exemption face of its invariant #1), ADR-0092 (holder in-place flip precedent), ADR-0037 / ADR-0096 (the worktree axis), ADR-0109 (in-fence ro-bind rides the exemption), ADR-0084 (user-layer settings discipline), ADR-0068 / ADR-0090 (hard wall unchanged).
