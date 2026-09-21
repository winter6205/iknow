# 0072. TUN egress filtering: feasible but not done

Date: 2026-09-09
Status: accepted

> **Amended (2026-09-16, ADR-0097)**: reopen trigger 3 (committing publicly to a domain-level whitelist) has been hit. But the implementation route is **not** the TUN form evaluated here — the domain whitelist takes the **proxy route** (netns full cut + unix-socket seam + host proxy judging the CONNECT host), bypassing the four components this document lists: TUN / userspace TCP-IP stack / TLS termination / self-built CA. This document's "not done" judgment on "kernel-level egress enforcement + content inspection" still stands; the proxy route does no content inspection and domain fronting is unpreventable (see ADR-0097 Trade-offs).

## Context

This document corrects one recorded judgment: **"forced egress filtering is impossible in unprivileged environments" does not hold for TUN**.

The earlier "impossible" judgment held for **veth** (an unprivileged user namespace cannot create a veth pair) but not for **TUN**. Measured evidence (2026-09-08):

1. `/dev/net/tun` exists with permissions `crw-rw-rw-` and opens normally;
2. `bwrap.ts:137-139` already does `--dev-bind /dev /dev`, so the device is visible inside the sandbox;
3. inside the netns freshly created by `--unshare-net` (`bwrap.ts:114`), bwrap holds CAP_NET_ADMIN.

So creating a TUN device inside the sandbox netns and having a host userspace process forward the traffic is a **path reachable without privileges**.

## Decision

**Not done.** Possible ≠ worth doing: the complete form is a subsystem, not a patch.

What it would take:

- a userspace TCP/IP stack or TUN forwarder;
- a host-side proxy process;
- TLS termination + a self-built CA — otherwise domain-level filtering can only see SNI, and clients fail outright on untrusted certificates;
- a fail-open / fail-closed choice when the proxy dies — fail-open equals no filtering; fail-closed turns sandbox networking into a single point of failure;
- the relationship with the two existing surfaces needs reworking: the `bash network:true` approval axis (ADR-0022) and `network-guard`'s six-layer defense (`network-guard.ts`).

**Real strength of the current substitutes (honestly labeled):**

- approval text that tells the truth + the `network_equals` eligibility gate = **informed + eligible**, not forced filtering;
- layer 4 of the default `web_fetch` / `web_search` path has a genuinely reachable DNS-rebinding TOCTOU — **being fixed** (the spike has settled on the focused-patch arm).
- **later readers must not be left assuming egress control already exists**: after approval (or with no eligibility rules), outbound content is still zero-filtered; the TOCTOU is a known real hole until the patch lands.

**Reopen triggers** — what would make this worth doing:

1. a real data-exfiltration incident;
2. the product opens to untrusted operators;
3. committing publicly to a domain-level whitelist.

## Side observation (not merged into this ADR)

`--dev-bind /dev /dev` (`bwrap.ts:137-139`) binds the whole device surface, while the file layer is a deny-by-default whitelist (`createClosedWorldFsPolicy` (**retired with ADR-0092 on 2026-09-13**)). The two postures are inconsistent. Likely not exploitable under userns, but worth a separate look — not expanded here.

## Consequences

- Under `docs/adr/`, `0046` and `0055` each have two files sharing a number (concurrent-session artifacts) — a pre-existing hygiene issue for the operator to adjudicate separately; this document does not renumber.
