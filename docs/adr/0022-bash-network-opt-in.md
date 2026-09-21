# 0022. bash network opt-in: per-call `network: true` drops `--unshare-net`, permission forces ask and full_auto grants no exemption

Date: 2026-08-18

Status: superseded by 0097

> **Superseded (2026-09-16, ADR-0097)**: the per-call `network:true` field and its ask rule (`code-ask-bash-network`) were abolished wholesale, with no old/new coexistence; `--unshare-net` became a constant, and egress = **an egress proxy seam** (a domain-allowlist proxy). The historical argument in this ADR is kept for traceability.

## Context

iknow's Bash tool runs inside the bwrap sandbox by default, with `baseArgs` hard-coding `--unshare-net` (`src/harness/sandbox/bwrap.ts:98`) — processes in the sandbox are fully isolated from the host network. That makes the "start a local service → verify from the host / browser / test client" loop impossible: the service binds successfully inside the sandbox but is unreachable from outside. On the other hand, `STATIC_NETWORK_WHITELIST` and the `assertDomain` check in `network-policy.ts:4` are already not executed at the fence layer (`bwrap.ts:156` simply does `void opts.networkPolicy`) — "domain filtering" is dead code in the current implementation, and there is no kernel-level handle to actually make it effective at the bwrap layer.

The demand signal is network visibility for **one-off service verification**, not permanent network opening. Three candidate answers: default isolation + explicit per-call opt-in, a settings-level network allowlist, allowlisted port mapping. This ADR picks the first and locks the permission surface, the ask hint, and the honest-declaration boundary along with it.

## Decision

Introduce `network?: boolean` as a per-call option in the bash tool's input schema (default `false`); when set, it opens exactly one approval axis — sandbox network — and touches not a single other fence. Six sub-decisions:

### 1. Per-call opt-in: `network: true` drops `--unshare-net`, all other fences kept

Add `network?: boolean` (default `false`) to the bash tool input schema. When `network === true`, the bwrap argv branch: drop `--unshare-net` from `src/harness/sandbox/bwrap.ts:98`; **keep every other fence** — `--unshare-user-try` / `--die-with-parent` / system `--ro-bind` (/usr /bin /lib /lib64 /etc) / fs-policy bind / `--size` / `--tmpfs /tmp` / env `--clearenv` + `--setenv` / `--chdir` / the 10-rule fence ordering discipline (the "Sandbox argv" section of `.claude/rules/security-boundaries.md`) stay untouched. On the default path (no `network` argument) the argv is byte-identical, with zero regression on existing `--unshare-net` assertions. Honest declaration semantics: `network: true` = **the whole bash call is granted host network egress**, with no finer control within the call (no per-port / per-domain / per-protocol splitting).

### 2. Permission forces ask; full_auto grants no exemption

Following the input-aware code-layer rule precedent at `policy.ts:56-65` (`code-allow-todo-write-list`), add one rule: `network === true` → `decision: ask`. Naturalness-of-implementation argument: `checkPermission`'s layered rules (step 2, `policy.ts:145-146`) are matched one by one and return **before** mode resolution (step 3, `policy.ts:152` `opts.mode?.get()`) — once the `network === true` rule hits, it returns `ask` directly, mode resolution is never reached, and the `full_auto` branch (`policy.ts:155`) cannot let this call through. "Fence shape change" and "action approval" are distinct approval axes: what environment an action executes in is a meta-decision a human must confirm before the action itself is approved — the existing precedence of hard-walls over mode (un-overridable in any mode) provides precedent for this design. The risk is bilateral expansion: without ask, one network authorization merges "environment trust" with "action trust", and users may silently approve an entire outbound command through non-interactive entry points.

### 3. Ask hint carries "requests host network" + command summary + secret warning

The ask view's summaryHint (`src/harness/permission/ask-user.ts:116` `PendingAskView`) gains a network semantics field or wording: must include a "requests host network" annotation + the command summary; when the pending command contains `<<<SECRET_N>>>` placeholders (roundtrip placeholderization output), append a secret warning — real values are re-injected before spawn (the bash restoration layer), so outbound data may carry real values; the readback mask only covers the "host → sandbox return path" display, not sandbox → network egress. Three isomorphic display surfaces gain the field in sync: `src/session-api/hub.ts:496` (`listPendingAsks` exposed to serve/SPA) → web `src/api/client.ts`, `src/tui/ask-user.ts`.

### 4. No allowlisted port mapping / domain filtering (honest declaration, into fog)

- **Allowlisted port mapping not adopted**: bwrap has no port-mapping primitive; mapping would require a userspace proxy (a new process-management surface, beyond sandbox scope) — conflicting with the "implement within bwrap's own primitives" constraint.
- **Domain filtering not done**: `STATIC_NETWORK_WHITELIST` is already not executed at the fence layer (`bwrap.ts:156` voids it); domain filtering has no kernel-level handle, and building it would be decoration that merely "appears to exist", violating the honest-declaration principle.
- **No project-settings network predicates**: configuring `network`-related open predicates in `settings.json` likewise goes into fog — the demand signal is one-off service verification; a settings-level allowlist is over-engineering with no execution handle.

Hence the semantics of `network: true` is exactly **whole-call host network egress**, without pretending finer control exists.

### 5. Egress-audit fog boundary

With `network: true` + a secret-bearing command, real secret values may leave with the command, and there is no egress-side audit in the sandbox → network direction. This ADR only promises the ask-time secret warning (decision 3) and **does no egress-side auditing** — into the map's Not yet specified, to be revisited when a demand signal appears.

### 6. Out of scope

- `bash_stop` / `bash_output` / background detach infrastructure — belongs to the Track A task cluster; this ADR is Track B's prerequisite document; the two tracks run orthogonally in parallel.
- Reviving `STATIC_NETWORK_WHITELIST` — status quo kept (not executed at the fence layer); this ADR neither wires it up nor deletes it in passing.

## Consequences

### Positive

- The loop capability is opened: a service with `network: true` can bind inside the sandbox and be genuinely reachable from the host / browser / test client — the "start service → verify → stop" e2e becomes testable.
- Zero change to the default security surface: calls without `network` keep byte-identical argv; existing `--unshare-net` assertions and probes stay green.
- Approval axes explicitly separated: environment trust (fence shape) is always confirmed once by a human and never blanket-approved by mode (including full_auto); whether the action is approved still goes through the existing mode/rule pipeline.
- Honest declaration eliminates fake granularity: no domain filter that never executes is deployed, avoiding the illusion of "safe-looking UI, naked reality".

### Negative / Trade-offs

- `network: true` = whole-call grant, coarse-grained — trusted processes can reach any host network resource from inside the sandbox; this is the chosen coarseness in the trade-off between "bwrap primitive capability vs userspace proxy complexity".
- Forced ask adds one human-confirmation round-trip at non-interactive entry points (ask / serve) — for network-requiring calls this is intentional friction, avoiding silent approval.
- The network security boundary becomes an external schema contract + permission-rule landing point; any later tightening/loosening moves user- and model-behavior anchors (see Reversibility).

### Concrete Quiddity

- `src/harness/sandbox/bwrap.ts`: `baseArgs` gains a network branch — with `network: true`, skip the single `--unshare-net` item, keeping all other argv order intact (the 10-rule fence ordering discipline remains the single authoritative order).
- `src/harness/permission/policy.ts`: new code-layer rule `code-ask-network-opt-in` (`network === true` → ask), mirroring the input-aware matching pattern of `code-allow-todo-write-list` (`policy.ts:56-65`).
- `src/harness/permission/ask-user.ts:116` `PendingAskView`: add a network semantics field; synced display at three places: `src/session-api/hub.ts:496` → web `src/api/client.ts`, `src/tui/ask-user.ts`.
- `scripts/sandbox-probe.ts`: new host-net category — inside the `network: true` branch, `curl` / port connect is reachable, unreachable in the default branch, alongside the existing 6 + 2 categories.
- Secret-warning trigger: the command string contains `<<<SECRET_N>>>` placeholders (roundtrip form); real secret values are never read into the view, only the warning is marked.

### Reversibility

**Hard to reverse** (meets the ADR three conditions). Point by point:

- **Hard to reverse**: `tool input → fence shape` is a brand-new approval axis — once the `network` parameter becomes an external schema contract, permission rules and `PendingAskView` fields depend on it, and probe assertions anchor on it, withdrawal requires simultaneously restoring four landing points: schema / policy rule / ask view / probe. Tightening or loosening the sandbox network boundary is a security promise that users' and models' behavior anchors to; it cannot be removed casually like an ordinary feature flag.
- **Surprising without context**: three easily misread points all need explicit ADR pinning — (1) why full_auto grants no exemption: the fence-shape axis is not the action-approval axis, the rule hits before mode resolution so the full_auto branch is never reached; (2) why no domain filtering: no kernel-level handle, already not executed at the fence layer, building it would be decoration; (3) why not a single other fence is loosened: network is not a trust upgrade — exactly one axis opens, all others keep their constraints. Without an ADR, implementers would try to "conveniently" widen allowances (env allowlist, `--unshare-user-try`) or grant full_auto exemptions.
- **Real trade-off**: three genuine trade-off points — per-call opt-in vs settings-level allowlist (the demand signal is one-off service verification; an allowlist is over-engineering with no execution handle, choose per-call); forced ask vs allow + warning (a fence-shape change deserves one explicit human confirmation, a warning is invisible at non-interactive entry points, choose forced ask); kernel netns toggle vs userspace proxy (one line within bwrap primitives vs a proxy introducing a new process-management surface and lifecycle, choose the former).

## Evidence

- Grilling resolution (locked 2026-08-18): "default isolation + per-call `network: true` opt-in", "forced ask following the `policy.ts:56-65` input-aware precedent, no exemption under full_auto", "allowlisted port mapping not adopted".
- Fact anchors: `src/harness/sandbox/bwrap.ts:98` (`--unshare-net` hard-coded), `bwrap.ts:156` (`void opts.networkPolicy`), `src/harness/sandbox/network-policy.ts:4` (`STATIC_NETWORK_WHITELIST`), `src/harness/permission/policy.ts:56-65` (input-aware precedent), `policy.ts:145-146` (layered rules return before mode), `policy.ts:152/155` (mode resolution / full_auto branch), `src/harness/permission/ask-user.ts:116` (`PendingAskView`).
- Implementation evidence across 3 commits, one logical task each: bwrap argv branch + new probe category → policy rule + ask hint + fields on three views + policy tests → start service → verify → stop e2e loop.
