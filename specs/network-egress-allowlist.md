# Spec: egress proxy seam — domain-allowlist network boundary

**Status:** ready for review (rev 2; the bridging implementation follows ADR-0107: no host socat)
**Surface:** `src/harness/sandbox/` (bwrap argv, new egress directory), `src/harness/aci/tools/bash.ts`, `src/harness/permission/` (delete the ask axis), `src/harness/background/`, `src/harness/verify/`, `src/config/settings.ts`, `scripts/sandbox-probe.ts`

## Goal

Change the bash fence's egress from a "binary switch" (network off by default / `network:true` fully open) to a **single channel**: the netns is permanently disconnected + the **egress proxy seam** + a **domain allowlist** decision. The model no longer needs per-call network parameters; egress qualification is answered only by "is the domain on the list", and failures carry actionable violation feedback.

User story: the operator wants the agent to run build commands like `npm install` / `git clone`, but **must not** be able to send arbitrary data to arbitrary sites. The status quo is "all off or all on" with no middle tier, and `STATIC_NETWORK_WHITELIST` is declared-but-unimplemented dead code. This spec lands the middle tier and settles the dead code.

## Boundaries

- **Does:**
  - `--unshare-net` becomes a **constant item** (never removed on any path), covering **all 3 fence assembly points**: foreground `bash.ts:271` / background `manager.ts:275` / verify `sandbox-run.ts:78` (measured: the subagent worker does not build its own fence; it goes through exactly these three).
  - New `src/harness/sandbox/egress/`: host egress proxy (HTTP CONNECT + SOCKS5) + **bridge** (unix socket → in-sandbox local port) + domain-matcher wiring + address-guard wiring + **violation recording and feedback**.
  - New **domain allowlist** decision: CONNECT host matching (`*.x` strict subdomains excluding the apex, optional `:port`, deny first) + address guard (rejects loopback / private / link-local / metadata).
  - **First-seen domain approval flow**: interactive entry, first-seen new domain → ask once via the existing ask surface; approval = session-level admission + optional persistence to user-layer settings; non-interactive entries (background / verify / no ask surface) **cannot ask = fail-closed rejection**, with the violation carrying the missing domain and remediation guidance.
  - Configuration surface: new user-layer settings keys (`isolation.network.allowedDomains` / `deniedDomains`), for **presets** and CI scenarios; project files not adopted.
  - **Deletion surface** (full list under "Deletion surface"): the bash input's `network?: boolean` field and its description; the `code-ask-bash-network` permission rule; the `isBashNetworkTrue` SSOT; all `wantsHostNetwork` branches; `BackgroundSpawnRequest.network`; the `network` field on the `AskUser` ctx; `NETWORK_HINT_MARKER` / `summarizeNetworkBash` / `NETWORK_HINT_TAIL` / `SECRET_WARNING`; the probe's opt-in categories.
  - Dependency introduction: `@anthropic-ai/sandbox-runtime` (Apache-2.0, exact version pinned) for the **network half only**; bwrap argv remains self-assembled (fsMode / workspace mount / argv ordering discipline unchanged).
- **Confirms with human:**
  - ~~The landing shape of first-approval persistence granularity (session-only vs writable back to the user layer).~~ **Adjudicated (2026-09-17)**: approval = session-level admission is mandatory; write-back to user-layer settings is an optional side action — a failed write-back degrades to session-only admission + a one-time warning, and the already-approved call executes normally. See ADR-0097 "approval persistence granularity".
  - ~~Proxy-process lifecycle details (foreground born/dies per call / the concrete implementation seam of the background bridge living to task end).~~ **Adjudicated (2026-09-17)**: the three shapes share the "start bridge → bind socket → inject env → cleanup" interface, with exception paths using the same release channel as normal paths; background hangs on `settle()`, verify is a module-level singleton. See ADR-0097 "proxy lifecycle / dispose contract".
- **Out of this spec:**
  - `--yolo` unsandboxed mode (separate ticket #1035; the two axes are orthogonal, yolo's exemption surface is adjudicated in that ticket).
  - The "run a service in the sandbox → host reachable" reverse channel (the core use case of the old `network:true`; untenable under the permanent netns disconnect — if needed, open an independent axis).
  - Content-level controls / TLS termination / credential injection (the ADR-0072 TUN-route scope).
  - The `web_fetch` / `web_search` `network-guard` stack (a different defense line, unaffected by this spec).
  - The worktree gate (`worktreeOnMutate`) — a different axis, unchanged here.

## Settled invariants

1. **Single channel**: `--unshare-net` always present; egress only via the proxy seam. No second exit, no escape switch.
2. **Decisions never inspect content**: the proxy looks only at the CONNECT host / absolute-URI host, no decryption. Never phrase it as content-level control.
3. **fail-closed across the board**: allowlist miss, proxy/bridge process dead, non-proxy-aware programs (raw sockets) = rejection or disconnection; never silent admission.
4. **Delete, not coexist**: the old per-call `network:true` semantics are removed wholesale, no dual track left.
5. **User-layer configuration only**: the allow/deny sets are read only from user-layer settings (ADR-0084 discipline); if the section appears in a project file, it is dropped.
6. **Address guard orthogonal**: a domain hit does not exempt the address guard — anything resolving into loopback / private / link-local / metadata is rejected.
7. **The configuration layer never throws**: illegal allowlist entries raise no exception (aligned with the "illegal values dropped without throwing" discipline at `settings.ts:34-43`) but **must leave a trace** — silent dropping equals letting the user believe the boundary took effect. The drop direction is always **tightening** (unreachable), never loosening.

## Violation feedback channel (converging the ACR error-handling item)

**Measured fact**: the proxy rejection text of `@anthropic-ai/sandbox-runtime` is a **hard-coded constant** (`ALLOWLIST_DENY` at `http-proxy.js:10-13`, no options injection point); the 403 body is always `Connection blocked by network allowlist` + `X-Proxy-Error: blocked-by-allowlist`. Therefore the "remediation guidance" **cannot** be carried by the package's own text and must be emitted by this repo.

(Inside the sandbox, `curl` still writes that 403 into its own stderr — that is a **command-layer** observation, independent from the **framework-layer** violation feedback below; the latter is what the model relies on to reconfigure.)

**Channel (named, three hops)**:

1. **Record**: the `filter(port, host, ...)` callback this repo passes to the proxy is **our** code. When it returns false, record a structured violation in place: `{host, port, reason: "not-in-allowlist" | "address-denied" | "no-approval-inlet", command}`. This is the sole authoritative rejection observation point.
2. **Feedback**: at call closeout the bash handler drains this call's violation records and **appends actionable text to the returned `stderr` field** (the `{code, stdout, stderr}` shape at `bash.ts:314-319` unchanged) — visible to the model via tool_result, visible to the TUI via the `meta.stderr` side channel (`bash.ts:320-326`).
3. **Prefix and tier entry**: the feedback text starts with the existing `VIOLATION_PREFIXES.networkDenied` (`[network_denied]`, `prefixes.ts:25`).

**The third hop's existing hook is unreachable in the current shape (ACR evidence; this section must change along)**: `violation-handling.ts:120-122` returns `tier: undefined` directly for results that are **not `execution_failed`**, while a non-zero exit of a sandboxed bash command still returns normally from the handler, so the result is always `kind: "ok"` (`buildOkResult` at `tools/executor.ts:259-275`) and the exit code is merely a JSON field of the payload (`bash.ts:316`). Hence the `networkDenied → mid` branch at `:139` **never hits** under the "append to stderr" shape.

**Selected shape ((a): convert to typed failure)**: a domain-decision rejection is a **boundary statement**, not a command's execution result — when rejected the call **never truly executed**, semantically it is a failure; stuffing it into an `ok`'s stderr is a shape mismatch.

- When the bash handler's closeout drains violation records, it does **not** return `ok`; it returns `execution_failed` (typed, with the full violation text in the message) — thereby the existing tier gate becomes reachable.
- That failure **still ran to completion** (the process was spawned and exited), so the text must also state "the command finished but egress was denied", so the model does not misjudge it as a process crash.
- **Counterexample (rejected)**: extending the tier gate to detect violations inside ok payloads — that would make "successful calls" and "calls rejected by the boundary" observationally identical, and since `violation-executor.ts:72-75` only reads `message` for failures, three places would need changing.

**Tests must go through bash's real return shape** (`{code, stdout, stderr}` via handler → executor); never reuse the direct-`kind: "execution_failed"` construction style of `violation-handling.test.ts:269-279` — for this item that style is a **false green**.

**The three classes of signals must be mutually distinguishable** (measured evidence, see Evidence pointers):

| Case                    | Proxy-side signal                             | Category        |
| ----------------------- | --------------------------------------------- | --------------- |
| allowlist miss          | 403 + `X-Proxy-Error: blocked-by-allowlist`  | domain rejection |
| admitted, upstream fails | 502                                          | upstream failure |
| proxy / bridge process dead | connection-layer refusal (ECONNREFUSED / bridge down) | infrastructure failure |
| non-proxy-aware program | no route (ENETUNREACH)                        | no egress qualification |

For "allowlist miss", the violation text must contain: the rejected domain, the current allowlist source (session-level / persisted / preset configuration), and remediation guidance (configuration key names + the interactive entry's approval prompt). For "infrastructure failure" the text must never phrase it as "domain rejected" — the two repair actions are entirely different.

## Failure paths (named paths required by the ACR error-handling item)

| Path                                      | Behavior                                                                                                           | Trace                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| host lacks `socat` (measured: not vendored) | **startup probe**: check the executable before bridge assembly; missing → the network capability fails closed, never silently degrading to "no network" | typed error + installation guidance (package name + local measured path) |
| no socat in the sandbox / bridge assembly failure | proxy unreachable → all egress calls fail (fail-closed), **no** fallback to direct connection                        | classified as infrastructure failure, with the assembly-failure cause |
| stale unix socket (proxy restart)          | socket path carries a per-session random id + cleanup before startup; connection refusals on leftover sockets are classified as infrastructure failure, never misreported as domain rejection | startup cleanup action + connection-failure attribution |
| approved write-back to user settings fails | **degrades to session-only admission**; the approved call **must execute normally**, never failing because persistence failed | one-time warning (explaining this admission is not persisted) |
| second request for the same domain while approval is pending | **wait** (merged into the result of one ask); no repeated asking, no immediate rejection                            | merged count into diagnostics |
| non-interactive entry, first-seen domain   | direct rejection (no ask surface to query)                                                                          | violation carries the missing domain + suggested configuration key |

## Input-contract classes (public surfaces)

| Surface                  | empty                        | invalid/negative                                                                                                                 | overflow                                      | concurrent                                    | exception                            |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| allowlist entries (config layer) | empty array → deny all (fail-closed) | non-string / trim-empty / bare `*` in allowed → **drop that entry + warn** (no throw)                                            | entry-count cap set in implementation, excess dropped + warn | N/A                                           | never throws (aligned with settings discipline), always traces |
| allowlist pattern (semantics layer) | N/A                          | `:port` out of range (0 / >65535 / non-numeric / empty) → **reject that entry + actionable diagnostic** (must not pass through to the matcher to silently degrade into never-matching); illegal wildcard position → same as left | N/A                                           | N/A                                           | no throw; diagnostics via the warning channel |
| first-seen domain approval | N/A                          | reject → that domain is not asked again this session                                                                              | N/A                                           | concurrent first-seen of the same domain → merged into one ask (later arrivals wait) | ask surface unavailable (non-interactive) → direct reject |
| proxy request             | N/A                          | allowlist miss → 403 + violation feedback; **malformed CONNECT** (empty line / over-long line / non-CONNECT method / missing authority) → reject, never silent admission or crash | over-long request line → reject (measured: the proxy already 403/400s, no crash) | concurrent requests share the proxy process  | proxy dead → connection failure (fail-closed) |
| bash input                | N/A                          | old `network` field passed in → unknown field (`additionalProperties: false` already pinned, `bash.ts:352`)                        | N/A                                           | N/A                                           | N/A                                  |

## Success criteria

- **SC1**: `--unshare-net` is present at all 3 fence assembly points (foreground / background / verify) — the probe asserts each one, including that the old `network:true` path no longer exists.
- **SC2**: a domain on the allowlist is reachable via the proxy (probe: `curl` through the proxy gets an HTTP response).
- **SC3**: an off-list domain is rejected, and the model-visible violation contains the rejected domain, the allowlist source, and remediation guidance (**through the three-hop Violation feedback channel**, landing in the tool_result message as `execution_failed`, never silent); tests go through bash's real return shape (handler → executor), never constructing `execution_failed` directly to fake green.
- **SC4**: address guard: an allowlisted domain resolving to private/loopback → reject (the DNS rebinding defense line).
- **SC5**: killing the proxy/bridge process → subsequent egress calls fail (fail-closed) with no direct-connection fallback; and it is **classified as infrastructure failure**, never confused with domain rejection (a test asserts the two signal classes are distinguishable).
- **SC6**: non-proxy-aware programs (e.g. raw sockets) have no route inside the sandbox — probe assertion.
- **SC7**: the dead code `STATIC_NETWORK_WHITELIST` / `NetworkPolicy.assertDomain` / `createNetworkPolicy` is removed or upgraded into real matchers, no "declared but unimplemented" residue; `VIOLATION_PREFIXES.networkDenied` is kept and wired to the real rejection path.
- **SC8**: the deletion surface leaves no repo-wide residue (grep assertions, list under "Deletion surface"), including the four coupling points named by the ACR.
- **SC9**: project-layer settings writing `isolation.network` → dropped (no effect), pinned by a test.
- **SC10**: first-seen approval flow: an interactive entry asks once for a new domain, and after approval no further asking within the session; concurrent requests for the same domain while pending merge into one ask; non-interactive entries fail closed directly (each with tests).
- **SC11**: all existing sandbox probe categories stay green (§security-boundaries discipline: any new fence flag requires `npm run probe:sandbox`).
- **SC12**: configuration-layer contract: empty allowlist denies all, `*` is dropped, `:65536` is rejected and **not** passed through as silent never-matching, illegal entries are dropped with a trace — each item has a test.
- **SC13**: with `socat` missing on the host, the network capability fails closed with installation guidance (tested with an injected probe result, not depending on whether CI happens to install socat).

## Deletion surface (converging the ACR minimal-change item: grep-proven list)

**Production code (point by point, all to be cleared; 17 files total)**:

| File                                              | Location                                                                                     | Object                                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/harness/aci/tools/bash.ts`                   | `:43`/`:45`, `:213-222`, `:261-278`, `:343-350`, `:368-375`, `:411-413`                       | the `network` field + schema item + description + all `wantsHostNetwork` branches                                        |
| `src/harness/permission/policy.ts`                | `:36`/`:40`, `:64`, `:109`                                                                    | the `isBashNetworkTrue` SSOT + the `code-ask-bash-network` rule                                                          |
| `src/harness/permission/permission-executor.ts`   | `:29`, `:331-342`, `:497-547`                                                                 | `isNetworkBash` / hint branches / `NETWORK_HINT_MARKER` / `summarizeNetworkBash` / `NETWORK_HINT_TAIL` / `SECRET_WARNING` |
| `src/harness/permission/types.ts`                 | `:117-124`                                                                                    | the `network?: boolean` on the `AskUser` ctx                                                                             |
| `src/harness/permission/declarative.ts`           | `:419-441`                                                                                    | the `network:` specifier family (`buildBashMatcher` branches)                                                            |
| `src/harness/background/manager.ts`               | `:34`, `:130-133`, `:265`, `:278-285`                                                         | `BackgroundSpawnRequest.network` + `createNetworkPolicy()` + fence opt                                                    |
| `src/harness/verify/sandbox-run.ts`               | `:16`, `:69`                                                                                  | `createNetworkPolicy()`                                                                                                  |
| `src/harness/sandbox/index.ts`                    | `:17`                                                                                         | the `createNetworkPolicy` export                                                                                         |
| `src/harness/sandbox/bwrap.ts`                    | `:154` (`network` parameter), `:160-162`, `:196`, `:220-224`                                  | the conditional `--unshare-net` + `void opts.networkPolicy`                                                              |
| `src/harness/permission/ask-user.ts`              | `:136-138`, `:200`                                                                             | the `PendingAskView.network` field + pass-through                                                                        |
| `src/tui/ask-user.ts`                             | `:20`, `:22`, `:86`                                                                           | the `network` field on the TUI-side ask view + pass-through                                                              |
| `src/tui/app.tsx`                                 | `:3573`, `:3629`                                                                               | the host-network marker rendering + pass-through |
| `src/tui/modal.tsx`                               | `:65-67`, `:77`, `:79`, `:141`                                                                | the **second** host-network marker rendering point (`:79`) + three `network` field declarations |
| `web/src/api/client.ts`                           | `:312`, `:314`                                                                                 | the web-side type + pass-through of `PendingAskView.network`                                                             |
| `web/src/components/PermissionDialog.tsx`         | `:52`, `:63`, `:65`                                                                           | web-side `host network` marker rendering (`aria-label` also needs changing)                                              |
| `scripts/sandbox-probe.ts`                        | `:58`, `:76`, `:127`, `:134`, `:137`, `:162`, `:169`, `:172`, `:489`, `:494`, `:503`, `:518` | the `NETWORK_POLICY` constant + the `network` parameter + two opt-in probe categories                                    |
| `scripts/sandbox-probe-subagent.ts`               | `:16-19`, `:228`, `:488`                                                                      | the `network:true` option in probe explanatory text (the fence posture itself unchanged; text + marker edit suffices)     |

**Note**: `VIOLATION_PREFIXES.networkDenied` (`prefixes.ts:25`) is **not deleted** — it is upgraded into the emission prefix of the real rejection path (see Violation feedback channel).

**Test migration list (directly pinning the deleted axis; rewrite rather than delete; 20 files total)**:

| Test file                                                   | network reference count | Disposition                                                                                                      |
| ----------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tests/harness/permission/policy.test.ts`                   | 34                      | remove the `isBashNetworkTrue` + `code-ask-bash-network` assertions (`:17`/`:403-429`)                            |
| `tests/harness/permission/bash-network-ask.test.ts`         | 29                      | rewrite for the new approval flow (first-seen domain ask / session admission / non-interactive fail-closed)       |
| `tests/harness/aci/bash-fence-parity.test.ts`               | 29                      | change to asserting the foreground/background sets are equal with `--unshare-net` always present                   |
| `tests/harness/permission/project-settings.test.ts`         | 24                      | assertion that `isolation.network` is dropped at the project layer                                                 |
| `tests/harness/aci/bash-service-loop.e2e.test.ts`           | 15                      | the e2e premise depends on `network:true` (`:5`/`:13-14`) → rebuild as proxy-reachable                              |
| `tests/harness/aci/bash-sandbox.test.ts`                    | 13                      | the `networkOptIn` suite (`:386+`) specifically asserts "removing `--unshare-net`" → flip                          |
| `tests/harness/aci/permission.test.ts`                      | 12                      | remove the network axis, keep the rest                                                                             |
| `tests/harness/permission/declarative-rules.test.ts`        | 11                      | assertions that `network:` specifier rules are removed                                                             |
| `tests/harness/permission/ask-user.test.ts`                 | 8                       | remove the `network` field assertions (`:243-262`)                                                                 |
| `tests/harness/sandbox/bwrap.test.ts`                       | 7                       | assertion that `--unshare-net` is always present                                                                   |
| `tests/tui/ask-modal.test.tsx`                              | 6                       | remove the `network` marker field                                                                                  |
| `tests/harness/aci/tools/bash.test.ts`                      | 4                       | remove `network` parameter-related assertions                                                                      |
| `tests/harness/aci/bash-main-session-fence-tmp.test.ts`     | 2                       | remove the `createNetworkPolicy` references (`:25`/`:80`)                                                          |
| `tests/harness/sandbox/bwrap-rebind.test.ts`                | 2                       | remove the `createNetworkPolicy` import and `networkPolicy` construction (`:14`/`:44`)                             |
| `tests/harness/sandbox/fs-mode-workspace.test.ts`           | 3                       | remove `createNetworkPolicy` (`:44`/`:102`/`:314`)                                                                 |
| `tests/harness/sandbox/fs-policy-boundary.test.ts`          | 4                       | remove `createNetworkPolicy` (`:8`/`:53`/`:148`/`:172`)                                                            |
| `tests/harness/verify/sandbox-run.test.ts`                  | 2                       | remove `createNetworkPolicy` (`:34`/`:180`)                                                                        |
| `tests/harness/sandbox/network-policy.test.ts`              | 2                       | the module under test is deleted entirely (`:24`) → delete the test file or retarget it at the new matcher         |
| `tests/harness/sandbox/violation-handling.test.ts`          | —                       | tier assertions after the `networkDenied` prefix upgrade; **and they must go through bash's real return shape** (see the false-green warning in Violation feedback channel) |
| `tests/harness/sandbox/secrets-no-leak.test.ts`             | 2                       | remove `createNetworkPolicy` (`:9`/`:66`); keep the secret-surface assertions                                      |

**CI exclusion note**: `bash-service-loop.e2e.test.ts` and `bash-sandbox.test.ts` are in `vitest.ci-excludes.ts:43,46` (not run in CI), but their semantics still require migration — the rewrite must not be skipped because CI doesn't run them.

**`createNetworkPolicy` compile cascade** (grep-proven): **10 files** under `tests/` import it (bwrap / fence-parity / bash-sandbox / fence-tmp / bwrap-rebind / fs-mode-workspace / fs-policy-boundary / sandbox-run.test / network-policy / secrets-no-leak) — when T8 deletes `network-policy.ts` these files **fail to compile**, all listed above; during migration remove the import and the `networkPolicy:` argument together (`createBwrapFence` no longer accepts that field).

**Repo-wide hit surface (re-verified by re-running grep)**: 16 files in `src/` + 2 in `web/` + 2 in `scripts/` = 17 production files (fully listed in the table); 23 files hit under `tests/`, of which 20 need migration (fully listed), the rest being harmless generic-word hits (e.g. zero references in `tests/tui/modal.test.tsx`).

## Dependency fork (ACR minimal-change item: spike closed)

**Measured conclusions (2026-09-16, package `@anthropic-ai/sandbox-runtime@0.0.76`)**:

- **Pure-logic pieces import standalone** (works even without node_modules): `domain-pattern.js`, `address.js`, `resolved-address-guard.js`, `parent-proxy.js`. These four depend only on `node:*` and each other.
- **Proxy server pieces need a full dependency install to import**: `http-proxy.js` (missing `node-forge` → `ERR_MODULE_NOT_FOUND`), `socks-proxy.js` (missing `@pondwader/socks5-server`).
- **`http-proxy.js` unconditionally pulls in `node-forge`** (re-adjudicated evidence, correcting the earlier misjudgment): `http-proxy.js:8` statically imports `CRL_PATH` ← `mitm-ca.js:10` top-level `import forge from 'node-forge'`. **"MITM is a lazy path" holds only at runtime** (without `mitmCA` no TLS is terminated); **it does not hold on the module load graph** — node-forge is a hard dependency. This changes no "no content inspection" semantics, but the dependency surface is larger than assumed: node-forge arrives with the package and cannot be trimmed.
- **The package has no `exports` field** — deep-path imports work but carry **no contract stability**.
- **`socat` is a host precondition dependency, not vendored** (the package's `vendor/` holds only seccomp / srt-win / java-proxy-agent).

**Adjudications**:

- Reuse its **matcher and address guard** (`domain-pattern` / `resolved-address-guard` / `address`), **do not reimplement** — but consolidated behind a **single adapter layer** (`src/harness/sandbox/egress/upstream.ts` or a single file at the same site), so version upgrades touch only that file and never leak outward.
- Reuse the proxy servers too (`http-proxy` / `socks-proxy`); do not rewrite the rejection text (borne by this repo's `filter`-side recording, see Violation feedback channel).
- **Missing `socat`** is handled per Failure paths (probe + fail-closed + guidance); this spec does not introduce socat distribution (supply-chain cost discussed separately).
- **Exactly one implementation of the address guard**: reuse sandbox-runtime's `resolved-address-guard`; do **not** write a second private-IP check beside the `network-guard` stack (`docs/CONTEXT.md` declares the two stacks non-interchangeable, but private-IP decision drift is a real risk).
- **Private-network rejection must be explicitly opt-in** (re-adjudicated evidence, otherwise SC4 falls flat): the reused piece's `DENIED_CLASSES` (`resolved-address-guard.js:52-65`) **deliberately excludes RFC 1918 / ULA / CGNAT**, with a comment stating "allow-listing an intranet hostname is legitimate, so those are opt-in via `network.deniedResolvedAddresses`" (`:131` is that entry). This spec's address-guard semantics require **rejecting private networks**, therefore **the adapter layer must pass `deniedResolvedAddresses`** (value domain = RFC 1918 + ULA + CGNAT + the existing link-local / loopback / metadata). This is not optional but the landing precondition of SC4; T3 acceptance must include that injection.
- **File-bearing discipline**: the bridge lifecycle and the new configuration-key parsing each go into separate files; `background/manager.ts` (already 836 lines) and `config/settings.ts` (already 1639 lines) gain wiring points only, no implementation bodies.

## Ownership / dispose contract (ACR non-blocking observation: pin the shape at spec stage)

Three shapes of proxy instances; the plan must land them as explicit interfaces (nothing left to implementation improvisation):

| Shape             | Lifecycle                | Release timing         |
| ----------------- | ------------------------ | ---------------------- |
| foreground bash call | per-call              | call closeout (exception paths included) |
| background task   | per-task, lives to task end | task termination / session end |
| verify            | with the host process, reusable | process exit         |

All three shapes share the "start bridge → bind socket → inject env vars → cleanup" interface; **exception paths must release** (leaked socat processes become the next call's stale-socket source).

## Open Questions

- The bridge-lifecycle closeout details for background tasks (the proxy process lives with the task; how to close at task end) — listed under `Confirms with human`, shaped in the plan stage.
- How the approval flow's ask text integrates with the three existing `PendingAskView` views (hub / TUI / web).
- Whether `socat` ultimately ships with the package (this spec treats it as a "host precondition dependency").

## Inherits / Changes

- **Inherits**: the argv ordering discipline of `src/harness/sandbox/bwrap.ts` (`.claude/rules/security-boundaries.md` "Sandbox argv": system ro-bind → user bind → `--size`/`--tmpfs` → cwd rebind → `--proc`/`--dev-bind` → `--chdir` → `--`); the `fence-tmp` assembly; the six-layer `network-guard` defense line (used by `web_fetch`/`web_search`, unchanged); `VIOLATION_PREFIXES` + the `categorizeResult` mid-tier upgrade hook (`violation-handling.ts:139`); the `PendingAskView` follow-up-question surface (three views); the `settings.ts` "illegal values dropped without throwing" discipline (`:34-43`).
- **Changes**: ADR-0022 → `superseded by 0097`; an amended addendum to ADR-0072; ADR-0097 (`proposed`; this rev adds the three measured facts: the socat precondition / hard-coded rejection text / deep-path imports); the three `docs/CONTEXT.md` entries already landed.
- **Dependency**: `@anthropic-ai/sandbox-runtime` (Apache-2.0, exact version pinned; its zod ^3 coexists nested with the project's zod ^4, project zod untouched; the lockfile change carries its introduction justification in the commit body).

## Evidence pointers

- Hard-coded proxy rejection text: `@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js:10-13` (`ALLOWLIST_DENY`), `:236-239`, `:458`.
- Three signal classes measured (2026-09-16 spike): allowlist miss → `403 + X-Proxy-Error: blocked-by-allowlist`; admitted but upstream dead → `502`; malformed → `400`; empty line → connection closed; over-long line (8 KB host) → 403 without crashing.
- Domain-matching semantics measured: `*.example.com` matches `api.example.com` / `a.b.example.com`, does **not** match the apex; `evilexample.com` / `example.com.evil.com` do not match (suffix anchoring correct); case insensitive; trailing dot **not** normalized.
- Port parsing measured: `:0` / `:65536` / `:99999` / `:abc` / `:` / `:-1` **do not throw**; they become never-matching hostname patterns as-is (→ this spec requires the configuration layer to reject them, not pass them through).
- socat precondition: `linux-sandbox-utils.js:437-438` (`socat not installed`), `:472` (`initializeLinuxNetworkBridge`); this machine's `which socat` = none; the package `vendor/` has no socat.
- Dead-code anchors: `src/harness/sandbox/network-policy.ts:4`, `bwrap.ts:220-224` (`void opts.networkPolicy`), `src/harness/sandbox/network-policy.ts:30` (`createNetworkPolicy`, zero production callers).
- Feedback shape: `src/harness/aci/tools/bash.ts:314-326` (`{code,stdout,stderr}` + the `meta` side channel); tier hook: `src/harness/sandbox/violation-handling.ts:139`.
- Project-layer drop discipline: `src/config/settings.ts:34-43`, `:1124-1145` (`parseIsolation`).
