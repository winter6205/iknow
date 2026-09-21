# 0107. Egress allowlist: deny by default + factory defaults ∪ user list; gate yes, host socat no

Date: 2026-09-19
Status: accepted

## Context

ADR-0106 locked bash egress down to "direct connection over the fence's host network, no domain gate". The operator vetoed: that is merely network-on/network-off — it cannot stop stray `curl` inside the fence. What is wanted is deny-by-default, factory defaults covering git/package managers, user-addable/removable entries, and unlisted domains going through approval or denial.

The defaults are still a **filter**, not "direct internet for anything on the list". Without an interception point there is no allowlist. 0097 used the host package `socat` to wire the netns to the proxy; the operator's objection is to **apt-installing socat**, not to the domain gate itself.

This decision **overturns 0106**, changing the bridge on 0097/0104's product semantics while keeping "bash egress is enforced by domain".

## Decision

**End state: the FS fence is kept; bash egress is denied by default; allowlist = factory defaults ∪ user-level `allowedDomains`, with `deniedDomains` taking priority; traffic exits only on a hit. Interception happens in the host proxy. No dependency on host `socat`.**

Locked sub-decisions:

1. **`--unshare-net` stays in the product fence.** Otherwise processes that ignore `HTTP_PROXY` (`curl --noproxy '*'`, bare SSH) bypass the list. Do not restore `network:true`, and do not build a sandbox master off-switch.
2. **The allowlist is effective, written in two places, enforced as a merge:**
   - **Factory defaults (code constants, SSOT in one frozen array):**  
     `github.com`, `*.github.com`, `*.githubusercontent.com`,  
     `registry.npmjs.org`, `registry.yarnpkg.com`,  
     `pypi.org`, `files.pythonhosted.org`,  
     `crates.io`, `static.crates.io`, `index.crates.io`,  
     `proxy.golang.org`, `sum.golang.org`,  
     `playwright.download.prss.microsoft.com`, `cdn.playwright.dev`.  
     Scope = the main git path + mainstream package managers + this repo's Playwright downloads. **Not in the tier:** model-provider APIs, container registries, GitLab/Bitbucket (user increments or the approval gate).
   - **User level** `isolation.network.allowedDomains` / `deniedDomains` **kept and enforced**. Not ghost keys. Project files are still not adopted (ADR-0084).
3. **No hit:** the interactive entry uses first-seen approval (approve = allowed for the session, optionally written back to the user-level allowed list); non-interactive is fail-closed + violation feedback. Deny takes priority.
4. **curl / git-https / npm:** routed through `HTTP_PROXY`/`HTTPS_PROXY` to the host proxy; the proxy checks the allowlist by CONNECT host; the address guard (refusing loopback/private/metadata) stays proxy-side.
5. **SSH / git-over-SSH:** the same allowlist, the same proxy (HTTP CONNECT or SOCKS — pick one and nail it down in the implementation; SSH must never connect directly to the host network). `GIT_SSH_COMMAND` injects a ProxyCommand. **socat is forbidden as a product dependency.** The relay = shipped by this repo / already-pinned runtime (a unix socket bound into the fence, or a minimal in-fence relay); no `apt install socat`. Missing relay = egress fail-closed, with a message naming this product's dependency rather than socat.
6. **Overturns 0106's "delete isolation.network / strip the write-back".** The old user list continues as user increments, merged with the defaults.
7. **The network-guard for `web_fetch` / `web_search` stays independent** (SSRF). bash `curl` goes through this ADR's allowlist, not the network-guard.
8. **0105 sentinel:** technically possible once the proxy is in place; **this ADR does not auto-enable it**. Does not block 0107.
9. **yolo / `full_auto`:** orthogonal. yolo without a fence means no gate; `full_auto` does not exempt the domain gate.

**ADR relationships:** 0106 is superseded by 0107. 0097's "domain gate + unshare-net + proxy" returns as product semantics, with **the clause "socat is a host prerequisite" deleted**. The 0104 preset tier returns as a subset of the defaults and the table is extended per this decision.

## Why not

- **0106's open network with no gate:** cannot stop stray `curl`. Already vetoed by the operator. Rejected.
- **Direct internet on-list, no interception:** with any NIC it's any domain — the allowlist is void. Rejected.
- **Keep apt socat:** already vetoed by the operator. Rejected.
- **Filter HTTP only, SSH direct:** two egress paths, SSH ungated. Rejected.

## Consequences

- An unapproved bash `curl https://example.com` is blocked; `curl https://github.com` / `npm i` / `git` (HTTPS and SSH) pass on the defaults.
- Landing surface: keep the proxy and `--unshare-net`; remove socat probing and installation text; replace socat on both sides with the self-shipped relay; extend the defaults array to this decision's list; the settings network section stays enforced.
- In-progress ssh-bridge / host-socat plans: **stop writing host socat**; the half-bridge, `GIT_SSH_COMMAND`, and allowlist adjudication may remain — merge after the relay is swapped to the self-shipped piece.

## Evidence pointers

- Operator, 2026-09-19: deny by default + factory defaults ∪ user list; no open-network-no-gate; keys stay only if enforced; no host socat.
- ADR-0097 / 0104 / 0106.
