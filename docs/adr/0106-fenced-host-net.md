# 0106. Fenced host network: direct bash egress on the host stack; retire socat / proxy seam / domain gate

Date: 2026-09-19
Status: superseded by 0107

> **Superseded (2026-09-19, ADR-0107)**: the requirement is a default-deny domain gate over shipped defaults ∪ the user allowlist, not open network without a gate. The fenced-host-networking direct connection in this file is void.

## Context

ADR-0097 built the bash egress as `--unshare-net` always on + unix socket + socat + HTTP/SOCKS proxy + domain allowlist. ADR-0104 added preset allowlists (GitHub / npm / Playwright) to avoid default-unreachable; ADR-0105 hung the HTTP credential sentinel on the same proxy. The unshipped ssh-bridge would additionally shove SSH through CONNECT.

The judgment then: on Linux socat is a host prerequisite, not shipped by this repo; direct SSH and HTTP CONNECT are mutually exclusive; once the preset allowlist is non-empty and we "allow listed domains directly", the kernel still cannot pass only those domains — a NIC means host networking for the whole call. This decision was once locked as "with a fence, connect directly, no domain gate", to avoid flip-flopping between socat / half-bridge / allowlist / sandbox-off. **Overturned by 0107.**

## Decision

(Historical text retained. The final state is ADR-0107; do not implement the clauses below.)

**Once-locked end state:** fence-bearing bash uses the host network stack directly; no `--unshare-net`; no proxy seam; no bash domain gate.

## Why not (at the time)

- Keep the 0097 seam and supply socat/ssh-bridge: the operator does not want host-side socat.
- Allowlist direct-connect but still filter by domain: impossible without an interception point.
- Default offline, opt in to networking: isomorphic to the 0104 "default unreachable" incident.
- Sandbox-off as default: loses the FS hard boundary.
- Hybrid HTTP proxy + direct SSH: two egress languages.

## Consequences

Per ADR-0107. This file does not guide implementation.

## Evidence pointers

- The operator locked direct-connect on 2026-09-19, then reversed to demand the domain gate → 0107.
- ADR-0097 / 0104 / 0105 / 0107.
