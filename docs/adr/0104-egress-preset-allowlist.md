# 0104. Egress domain allowlist: a code-borne default preset tier (overturns the ADR-0097 clause "no preset fallback set")

Date: 2026-09-19
Status: accepted

> **Amended (ADR-0107)**: the defaults list is extended to git + mainstream package managers + Playwright (see 0107 §Decision 2). Once marked superseded by 0106; 0107 restores enforcement.

## Context

ADR-0097 built the egress proxy seam but adjudicated "**No** 'preset fallback set of common domains' — that equals silently widening the boundary", defaulting to an empty set, fail-closed, with the allowlist honoring user-layer settings only. In implementation, `createEgressPolicyFactory` returns `undefined` directly when the user-layer `isolation.network` section is absent = no egress session starts for the call (no proxy env inside the sandbox, `assembly.ts:84-89`) — even though the interactive entry's approval flow could obviously ask, the first-seen-domain approval gate never gets triggered (an implementation gap against the 0097 lifecycle table's start condition "allowlist non-empty **or the approval flow can ask**"). A measured session (2026-09-18, conversation `ee13c787`) confirmed the consequence: `git push` / `gh` all failed DNS resolution; the model burned about 12 minutes on 6 dead-end workarounds (SSH parameters, hunting for proxy env, tool_search, curl probing), and the PR never opened. "Safe by default" degraded in practice into "unreachable by default": users do not preconfigure an allowlist, and the approval gate died at the entrance.

## Decision

1. **A code-borne default preset tier (builtin preset)**, allowed out of the box:
   - `github.com`, `*.github.com`, `*.githubusercontent.com` — HTTPS git, PR/REST API (api/codeload/uploads), release/raw assets;
   - `registry.npmjs.org` — the package-management main path;
   - `playwright.download.prss.microsoft.com`, `cdn.playwright.dev` — webui test browser binaries.
2. Merge semantics: full allowlist = preset ∪ user-layer `allowedDomains` increment; `deniedDomains` **deny-first** unchanged; the address guard (rejects loopback / private / link-local / metadata) unchanged; project files not adopted (ADR-0084 discipline) unchanged — the preset is code-borne, travels through the code-change flow and review, it is not "self-granted by the project repo".
3. **Model-provider API domains are explicitly not preset**: API keys exist inside the fence, so presetting them opens a direct secret-transmission channel; such domains go through the first-seen approval gate (ask a human once when present).
4. Preset admission principle: admit only high-frequency domains of the "reproducible build / delivery flow" (git, PR API, package management, test browser binaries); **the narrower the allowlist, the more valuable the approval gate**. Future preset additions must argue against this principle.

## Why not

- **Keep the empty-set default + recommend configuration in docs**: default-unreachable has been measured as a failure mode; it amounts to requiring every user to hit the wall first and then configure, and when the config section is absent the session does not start and the approval gate is not even offered the chance to ask — the empty-set default did not preserve the "ask once" interaction, only the dead end.
- **Preset the LLM API domains**: the secret-exfiltration surface outweighs the convenience; agents running real model tests inside the fence is a low-frequency scenario, one approval-gate click suffices.

## Consequences

- Overturns the ADR-0097 Decision clause "no 'preset fallback set of common domains'" and revises its "the allowlist honors user-layer settings only" wording to "preset (code-borne) + user-layer increment"; all other 0097 clauses (`--unshare-net` always on, the proxy-seam structure, the first-time approval flow, the address guard, violation feedback, the lifecycle table) stand verbatim.
- 0097's concern about presets (silent widening) is absorbed by three points: the preset is code-borne, auditable, changed through review (not silent); the narrow-admission principle; explicit exclusion of LLM API domains. Accepted residual risk: preset domains become a default-present data-exfiltration surface (domain fronting is undefendable, consistent with 0097 §Trade-offs, not qualitatively enlarged by this decision).
- Side effect (positive): a non-empty preset means production entries start the egress session by default, the first-seen approval gate returns from "dead at the entrance" to on-duty, and the 0097 lifecycle-table implementation gap described above is fixed.
- Left over (outside this ADR): SSH remote push needs a git-over-SOCKS / ProxyCommand form (a 0097 form extension); the credential surface (gh login state, ssh-agent) egress is a separate case — the escape-through-the-reexecution-seam issue awaits its own project.

## Evidence pointers

- Session transcript `~/.iknow/projects/iknow-ddcb805367a0/ee13c787-5958-4524-95d3-0e89d520f12a/` (2026-09-18): `Could not resolve hostname github.com`, `gh auth status → X Failed to log in`, `tool_search("push pull request github remote") → no matches`, no proxy env.
- `src/harness/sandbox/egress/assembly.ts:84-89` (config section absent → `undefined` → session does not start); `src/harness/aci/tools/bash.ts:130-135` (the default = pure network cut, a legitimate fail-closed state).
- `docs/adr/0097-egress-proxy-seam-domain-allowlist.md` §Decision (the original "no preset fallback set" clause), §lifecycle table (start condition "allowlist non-empty or the approval flow can ask").
- Domain-matching semantics (already measured in 0097): `*.x` is a strict sub-domain excluding the apex — the `github.com` apex and `*.github.com` must be listed side by side; omitting either leaves a gap.
