# Spec: egress domain allowlist — code-carried default pre-admission tier (builtin preset)

**Status:** draft (rev 1; the defaults list is superseded by the ADR-0107 table expansion)
**Basis:** ADR-0104 (overturns ADR-0097 Decision "no fallback preset of common domains", revises "the allowlist recognizes only user-layer settings" to "preset (code-carried) ∪ user-layer increment"); `docs/CONTEXT.md` entries "pre-admission tier (builtin preset)" and "domain allowlist"; continues `specs/network-egress-allowlist.md`
**Surface:** new `src/harness/sandbox/egress/preset-domains.ts`, `src/harness/sandbox/egress/assembly.ts` (merge semantics + factory always returns a policy), `session.ts` / `violations.ts` (`allowlistSource` label redefinition), `src/harness/aci/tools/bash.ts` (source fallback wiring), existing egress tests (assertion flips in `tests/harness/sandbox/egress-assembly.test.ts` etc.)

## Goal

Turn the empirically proven failing shape of "safe by default" (default-unreachable: `git push` / `gh` all DNS failures, the approval gate dead at the inlet, the model burning 12 minutes on 6 dead-end workarounds — conversation `ee13c787`) back into something usable: ship with a **pre-admission tier** (code-carried 6 high-frequency build/delivery domains) and restore the ADR-0097 lifecycle-table session-start condition "start only when the allowlist is non-empty **or the approval flow is askable**" — a non-empty preset makes production entry points start the egress session by default, and the first-seen approval gate returns from dead code to active duty.

## Boundaries

- **Does:**
  - New `preset-domains.ts`: `BUILTIN_PRESET_ALLOWED_DOMAINS` (frozen array, **the list's SSOT is this single place**) = `github.com`, `*.github.com`, `*.githubusercontent.com`, `registry.npmjs.org`, `playwright.download.prss.microsoft.com`, `cdn.playwright.dev` (apex listed alongside `*.x` — measured 0097 semantics: `*.x` strictly excludes the apex, so omitting one leaves a hole). **Registration: the current list follows ADR-0107 §Decision 2's fourteen entries (table-expansion commit 7be192df); the 6 entries here are the ADR-0104 origin shape, kept for historical continuity. The list SSOT remains `preset-domains.ts` alone.**
  - `createEgressPolicyFactory` merge semantics: `allowedDomains = preset ∪ user-layer allowedDomains` (after dedup, order: preset first, user increment second, for human readability); `deniedDomains` taken from the user layer only, **deny-first unchanged** (users can cut any preset domain precisely via denied).
  - **Start the session even when the configuration section is absent**: when `settings.isolation.network === undefined` the factory no longer returns `undefined` but a preset-only policy (see T1; this also closes the 0097 lifecycle-table implementation gap, explicitly cited below).
  - `allowlistSource` label redefinition + violation-text linkage (see T2).
  - The three consumer surfaces (foreground bash / background / verify, all derived via `createEgressPolicyFactory`) automatically gain the preset; no per-surface wiring needed.
- **Unchanged (explicitly restated to prevent drift):**
  - `--unshare-net` always present, proxy seam structure, address guard (loopback / private / link-local / metadata + `DEFAULT_PRIVATE_DENIED_RANGES` opt-in injection), first-seen approval flow, the three-hop violation feedback channel — all verbatim per ADR-0097 / the previous spec.
  - **Project files not adopted**: `mergeIsolationNetwork` ignores the project section (ADR-0084 discipline); the preset's legitimacy comes from "code-carried, through the code-change flow and review", not from loosening at any settings layer.
  - Model-provider API domains are **explicitly excluded** (keys exist inside the fence; pre-admission = a direct secret-transit channel) — pinned by a unit test asserting the preset list contains no known provider domain.
  - Pre-admission admission principle: future preset additions must be argued against "reproducible builds / high-frequency delivery-flow domains" (ADR-0104 §Decision 4) through code review.
- **Out of this spec:**
  - SSH remote push (git-over-SOCKS / ProxyCommand, the 0097 T7/T8 extension leftover); egress for the credential surface (gh login state, ssh-agent) is a separate project.
  - The `web_fetch` / `web_search` network-guard stack (a different defense line).
  - settings schema shape changes (the `isolation.network` keys are unchanged; only the downstream semantics of "absent" shifts from "no session" to "preset session").

## Settled invariants

1. **The preset is a code constant, not configuration**: no new settings keys; the whole tier cannot be turned off via project files / user configuration (users may cut individual entries via `deniedDomains` — deny-first is the escape hatch; no "disable tier" switch is needed).
2. **Allowlist universe = preset ∪ user increment, deny first**: decision-input construction happens only in assembly (SSOT); no consumer surface may re-stitch the preset itself.
3. **The egress session start condition fulfills the 0097 lifecycle table**: under production assembly the factory **always returns a policy** (non-empty preset ⇒ "allowlist non-empty" is always true); the `undefined` branch of `EgressPolicyInput | undefined` survives only for "caller explicitly does not assemble egress" test / yolo-class exemption paths, and is no longer triggered by "settings section absent". ADR-0097 §lifecycle table "bash handler fence assembly time, start only when this call qualifies for egress (allowlist non-empty or approval flow askable)" — the current implementation (`assembly.ts:84-89`, section absent → `() => undefined`) diverges from that table; this spec closes the gap via the non-empty preset, creating no textual exception.
4. **`allowlistSource` semantics and name-collision settlement**: the current value `"preset"` means "user-layer preset settings section" and **collides** with ADR-0104's new term "pre-admission tier = builtin"; this spec redefines it as the closed three-tier `"builtin" | "persisted" | "session"` (see the T2 table), changed in one pass across the whole chain (types, producers, rendering, tests), leaving no alias for the old value.
5. **The fail-closed surface does not shrink**: approval-gate rejection on non-interactive entry points, proxy-dead fail-closed, address-guard orthogonality — previous spec invariants 3/6/7 inherited verbatim.
6. **Pure infra messaging stays free of configuration guidance** (previous spec "three classes of signals distinguishable"): the new source label appears only in the domain-decision segment.

## allowlistSource redefinition (the pinned table of T2)

| Tier          | Producer                                                                                                                 | Semantics                              | Violation-text `SOURCE_LABEL` (English rendering line keeps the fixed format: `Current allowlist source: <label>.`) |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `builtin`     | `assembly.ts`: settings `isolation.network` section **absent**                                                            | only the factory pre-admission tier present  | `built-in preset allowlist (github / npm / playwright defaults)`                                                     |
| `persisted`   | `assembly.ts`: settings section present (the true name of the old `"preset"` value)                                       | user-persisted settings increment merged in | `user-settings persisted allowlist`                                                                                  |
| `session`     | `bash.ts` factory wrapper: fallback when the caller has not explicitly set a source and an interactive approval surface is present (existing fallback logic switched to a constant reference); approval-flow products | session-level approved admission present | `session-level allowlist`                                                                                            |

Linkage points (grep-verified complete set): `violations.ts:29` (`EgressAllowlistSource` type), `violations.ts:173-177` (`SOURCE_LABEL`), `session.ts:78` (inline union switched to referencing `EgressAllowlistSource`, eliminating two-place drift), `assembly.ts:19/:66-70/:104/:119` (comments + assignments), `bash.ts:632-645` (fallback comment and `"session" as const` kept, comment restated), `tests/harness/sandbox/egress-violations.test.ts` etc. The `persisted` tier has a real producer from the start (the old `"persisted"` value had zero producers — a placeholder).

## Task breakdown

### T1 — preset constant + merge assembly (`preset-domains.ts` + `assembly.ts`)

- `BUILTIN_PRESET_ALLOWED_DOMAINS`: frozen, the 6 entries verbatim = the Boundaries list; the file comment cites ADR-0104 and the admission principle.
- `createEgressPolicyFactory`:
  - section absent → `() => ({ allowedDomains: [...preset], deniedDomains: [], commandLabel, allowlistSource: "builtin" })` (**no longer returns `undefined`**);
  - section present → `allowedDomains = dedup(preset ∪ network.allowedDomains)`, `deniedDomains = network.deniedDomains ?? []`, `allowlistSource: "persisted"`;
  - user section present but both lists empty → same "present" path (the preset is still in effect; `allowlist-empty` is unreachable through the factory path, see Failure paths F2).
- `buildEgressPolicy` signature takes the preset source; the factory return type stays `() => EgressPolicyInput | undefined` and does not narrow (background / verify consumer surfaces: zero type changes), though the production assembly path always returns non-`undefined`.

**Acceptance**: `egress-assembly.test.ts` assertion flips — the old "section absent → undefined" becomes "section absent → preset-only policy, source `builtin`"; merge dedup, preset-first ordering, user empty lists not overriding the preset, feeding the merge result directly to `decideEgress`: `github.com` apex and `api.github.com` (`*.github.com`) both hit, `registry.npmjs.org` hits while the `npmjs.org` apex does **not** (the list wrote only the registry subdomain — pinned against accidental expansion), `evil-github.com` / `github.com.evil.io` miss (suffix-anchoring regression).

### T2 — `allowlistSource` redefinition and text linkage

Per the table above, rename / re-value / re-render `"preset"` across the whole chain; the `session.ts` inline union converges to a reference; the `not-in-allowlist`, `no-approval-inlet` / `denied-by-user` line texts keep their structure (configuration-key guidance still points at `isolation.network.allowedDomains` — with the preset present, the user increment remains where you add domains).

**Acceptance**: each of the three `EgressAllowlistSource` tiers has a real producer plus a consumption-rendering test; grep asserts no string `"preset"` residue at any source-semantic site repo-wide (except the `"built-in preset allowlist"` rendering text); after migration the source-annotation pin-nails of `bash-egress-typed-failure.test.ts` / `egress-violations.test.ts` are green.

### T3 — approval gate back on duty + lifecycle-gap-closure test pin

- Foreground bash (interactive entry): under a **clean assembly with no settings network section**, accessing an off-tier domain (e.g. `example.com`) → the first-seen approval gate fires (asks once), approve → admitted for this session; deny → `denied-by-user` violation fed back as `execution_failed`.
- background / verify (non-interactive): under clean assembly, an off-tier domain → `no-approval-inlet` fail-closed (distinguished from the old "session never starts, command purely DNS-dead" — now the violation feedback **has a name**, and the model gets actionable text rather than a silent DNS failure).
- Lifecycle-table closure: `build-engine-egress-wiring.test.ts` gains an assertion — with `settings` lacking `isolation.network`, `egressPolicyFactory()` returns non-`undefined` (citing ADR-0097 §lifecycle table + ADR-0104 §Consequences "side effects (positive)").

**Acceptance**: each of the three above has a unit test (reusing the T6 filter-injection driver seam, never actually starting a proxy); the old "approval gate dead at the inlet" behavior gets a flip-recorded regression test.

### T4 — preset domains truly reachable (probe / field-test layer)

- `npm run probe:sandbox` keeps all categories green (repo rule: any fence-touching change must run it); if the probe network category's current shape (`sandbox-probe.ts:291-367` loopback listener tier) is awkward to extend with real domains, **do not force a real-network probe** (CI network surface is unstable) — reachability evidence moves down to the T5 field test.
- Decision layer: `decideEgress` pure function eats the merged set (already in T1).

**Acceptance**: probe all-green report; if a real-domain probe category is added during implementation, sync the `security-boundaries` 11-category probe discipline note — by default **do not add**, avoiding CI flakiness (registered here).

### T5 — TUI pty field test (repo-rule ground truth for session-entering changes)

Start the TUI via `mcp__aiterm__pty_*` (clean settings: no `isolation.network` section): ①`curl -sI https://github.com` goes through (inside the preset tier, no approval needed); ②`curl -sI https://example.com` triggers the first-seen approval gate, deny → the on-screen tool_result contains `[network_denied]` plus the literal `Current allowlist source: built-in preset allowlist (github / npm / playwright defaults).`, approve → re-visiting in the same session asks no more; ③`git push --dry-run` (https remote) is reachable within the tier (if the credential surface is not ready, register it honestly as a leftover — not a failure of this tier; Boundaries Out of scope).

**Acceptance**: on-screen evidence for the three operations (transcript snippets) archived in the acceptance report.

**Field-test registration (T5 first run)**: inner-bridge cold-start race — a bare `curl` issued CONNECT before the relay was listening and got ECONNREFUSED (exit 7); the probe side absorbs it with `--retry-connrefused` (`sandbox-probe.ts:371`), the product path has no absorber. Fix = prepend a readiness-polling line in `buildInnerBridgeScript` (frozen-shape revision registered in `specs/egress-ssh-bridge.md` T1 section); after the fix, T5 re-runs with bare curl as the baseline.

## Failure paths

| #   | Path                                          | Behavior                                                                                                                                                         |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | user `deniedDomains` contains `*.github.com`   | deny-first cuts the preset subdomain; the `github.com` apex remains (measured pattern semantics: `*.x` excludes the apex) — both text and tests pin this asymmetry |
| F2  | `allowlist-empty` reason                       | unreachable through the factory path (the preset is always non-empty); the decision and rendering pieces are kept (sessions may be fed an empty set directly by tests / other callers); code not deleted |
| F3  | user settings section dropped as illegal by the settings layer | `network = undefined` → **preset-only session start** (the old behavior was "no session"; the new behavior keeps fail-closed semantics unchanged — the preset is still a narrow set, and the drop-with-trace discipline is already borne by the settings layer) |
| F4  | host missing socat                             | tier-irrelevant: session cannot start → `SocatUnavailableError` → infra text (with installation guidance), never masquerading as a domain-decision rejection (the existing SC13 surface; regression suffices) |
| F5  | a preset domain resolves to private/loopback (rebinding) | the address guard still rejects (invariant 5: preset hits do not exempt the guard), `address-denied` text unchanged                                                  |
| F6  | yolo / isolation OFF assembly path             | no fence ⇒ no egress consumer surface, the two axes orthogonal (0097 boundary unchanged); confirming `createEgressPolicyFactory` is not called on that path suffices; no logic added |

## Success criteria

- **SC1**: under clean assembly (no network section at all) all three consumer surfaces start an egress session, allowlist = the 6 preset domains; the `assembly` return-`undefined` branch is unreachable on the production assembly path (wiring test).
- **SC2**: the preset list verbatim = ADR-0104 §Decision 1's six entries, SSOT single file; includes a reverse-assertion test "no known LLM provider domain". (Registration: "six entries" is the origin-shape historical wording; the current criterion = ADR-0107 §Decision 2's fourteen entries verbatim, see the current `preset-domains.ts`.)
- **SC3**: four merge assertions: apex+subdomain listed jointly and hitting, user-increment union, deny-first can cut the preset, user empty lists do not shrink the tier.
- **SC4**: the three `allowlistSource` tiers `builtin/persisted/session` each have a producer and a `SOURCE_LABEL` rendering pin-nail; the old `"preset"` value cleared repo-wide (grep assertion).
- **SC5**: the first-seen approval gate can fire under clean assembly (interactive: asked once / non-interactive: `no-approval-inlet`), closing the existing gap between ADR-0097 §lifecycle table and the implementation (the T3 pin-nail explicitly cites that table).
- **SC6**: `npm test` all green (including the flipped `egress-assembly` / `bash-egress-approval` / `bash-egress-typed-failure` / `build-engine-egress-wiring` / `egress-violations` plus manager / verify related migrations) + `npm run probe:sandbox` all green + TUI pty field test (T5) evidence archived.
- **SC7**: project-layer settings writing `isolation.network` still drops the whole section (previous spec SC9 regression, not loosened by the preset's introduction).

## Inherits / Changes

- **Inherits**: all of `specs/network-egress-allowlist.md`'s Settled invariants / Violation feedback channel / Ownership-dispose contract / three-signals-distinguishable; ADR-0084 project-layer non-adoption; `decideEgress` decision ordering and the address-guard tier.
- **Changes**: two items of ADR-0097 (already landed via ADR-0104 + the 0097 Amended clause; this spec does not edit ADRs); `assembly.ts` fail-closed default semantics (section absent = no session → section absent = preset session); the `EgressAllowlistSource` enum redefinition; the `CONTEXT.md` "pre-admission tier" and "domain allowlist" entries already landed with fa7e8ac1 and this spec aligns with them (the name-collision settlement is precisely the entry's canonical code name, builtin preset).
- **Untouched**: settings schema, domain-matcher decision ordering, session/proxy/bridge lifecycle, violations recording and drain channels.

## Open questions

- OQ1: writing approvals back into user-layer settings (0097's "optional side action") still has no implementation (no writeBack path in `approval.ts`, `"persisted"` had no producer) — this spec's `persisted` tier is provisionally produced by "settings section present"; when a write-back API lands it should attach the source label for post-approval persistence; whether to extend to a fourth tier (approved-and-written-back) is deferred, not blocking this spec.
- OQ2: whether `playwright.download.prss.microsoft.com` / `cdn.playwright.dev` cover real CI-mirror needs is re-checked via the T5 field test (webui browser binary download); if other high-frequency build domains need admission, follow ADR-0104 §Decision 4's admission principle through a separate code-change flow, outside this spec.

## Evidence pointers

- Incident: conversation `ee13c787-5958-4524-95d3-0e89d520f12a` (`Could not resolve hostname github.com`, `gh auth status → Failed to log in`, no proxy env).
- Implementation-gap anchor: `src/harness/sandbox/egress/assembly.ts:84-89` (section absent → `() => undefined`) vs ADR-0097 §lifecycle table "start only when the allowlist is non-empty or the approval flow is askable".
- Name-collision anchor: `assembly.ts:19/:119` (current `"preset"` = user-layer preset) vs `docs/CONTEXT.md:214` ("pre-admission tier (builtin preset)" = code-carried).
- Consumer surfaces: `bash.ts:636-657` (factory wrapper + session fallback), `background/manager.ts:171`, `verify/sandbox-run.ts:67`, `build-engine.ts:1193-1200`.
- Decision and text pieces: `domain-matcher.ts` (`decideEgress` ordering, `DEFAULT_PRIVATE_DENIED_RANGES`), `violations.ts:29/:173-177` (source type and labels).
- Measured-semantics premises: `*.x` excludes the apex / suffix anchoring / case insensitivity (ADR-0097 §Evidence pointers).

## ACR Verdict (architecture-change-reviewer · 5-verdict gate)

```text
bounded-context-guardian: yes — single SSOT: the preset list lives only in preset-domains.ts (Boundaries Does#1 "this single place"), the merge only in assembly (invariant 2); settings schema unchanged (Out#3); grep proves domain-matcher.ts/approval.ts contain zero "preset" references, egress never imports config in reverse (assembly.ts:8-9 DI discipline kept)
defensive-contract-validator: yes — five merge boundaries each pinned: dedup+ordering (T1), deny-first cutting the preset with F1 pinning the `*.github.com` apex-exclusion asymmetry, user empty lists not shrinking the tier (T1 both-empty path + SC3), illegal entries traced by the settings layer's parseIsolationNetwork+onWarn then F3 falling back to preset-only, approval gate asks once (T3 interactive/non-interactive arms)
error-handling-enforcer: yes — F1-F6 all typed (denied-by-user / no-approval-inlet / address-denied / SocatUnavailableError / allowlist-empty kept for the direct-feed path F2), T3 makes "silent DNS failure → named actionable violation" explicit, the three source tiers form a closed union with "no alias left for the old value"
complexity-anti-drift: yes — reuses the decideEgress/approval seams without building new matchers (Inherits "untouched" + T3 "reuse the T6 filter-injection driver seam"); the allowlistSource blast radius enumerated with grep evidence (violations.ts:29/173-177, session.ts:78, assembly.ts:19/119, bash.ts:643-644)
minimal-change-verifier: yes — scope strictly maps ADR-0104 §Decision 1-4; SSH/SOCKS, the web_fetch stack, settings write-back (OQ1 explicitly non-blocking), schema changes all listed Out-of-scope; the T2 name-collision settlement is necessary cleanup, not smuggling
OVERALL: PASS — hand to writing-plans
```
