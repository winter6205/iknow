# 0112. Instruction-authority outbound projection: host frames carry the stamp; untrusted channels cannot forge the official plate

Date: 2026-09-19
Status: accepted

## Context

The exposed problem: the model's trust in "official appearance" rests on **how a message looks** — a complete `<agent_status>` block or system-prefix-style text inside a tool result can impersonate a host frame and raise privilege on the instruction surface. The existing read rule (`IKNOW_AGENT_STATUS_READ_RULE`) declares the newest XML tag in the transcript authoritative, which delegates anti-forgery to "the model reads the same string and behaves".

Three existing adjudications delimit where this decision lands:

- **ADR-0009**: channel-based trust — labeling is not a defense; deciding authenticity by parsing a tag roster is itself a forgeable plate. This ADR extends that ruling to the instruction surface.
- **ADR-0028**: the status bar is a per-hop appended user injection — it goes into messages, not into `deps.system`; the projection discipline must not be turned into "move the bar into system" (that would break the KV-cache contract).
- **ADR-0044**: low-provenance sources (memory bodies, a parent-writable `systemPrompt`) must not buy into system's highest-trust slot. A worker's LOCKED constitution is likewise not overwritable by a parent addendum.
- **Contract X / observability side-channel** (the ADR-0036 line): the on-disk source of truth ≠ the bytes visible to the model. "Disk may be dirty, the wire is a derived view" is this decision's existing baseline, not a new invention.

## Decision

**Instruction authority converges into a single outbound projection: the authoritative history stays append-only and may be dirty; the bytes sent to the model are projected by message provenance in code, and official appearance comes only from stamped host frames.**

Locked sub-decisions:

1. **Host injections get a non-model-visible provenance stamp at commit.** Status-bar-like `encodeUserText` injections are stamped when written into LoopState; the serialization to the wire strips the stamp itself. The stamp is an internal convention between the host and the projection function, never model-readable content.
2. **`buildMessageParams` is a pure-function projection of `LoopState` + `request.system`.** Same history → same wire bytes, KV prefix stable; it must not stuff freshness into `system` by rewriting it each hop.
3. **Stampless / `tool_result` text is deterministically transcoded.** After the payload reaches the wire it must not contain unescaped tag syntax that the read rules could take for a host frame — untrusted content cannot reproduce host syntax; the content remains readable, no data is lost. The transcode never writes back to the authoritative history and does not change the TUI's displayed original.
4. **The worker LOCKED constitution is not bought in by a parent addendum.** `envelope.systemPrompt` must not override the LOCKED six sections; addenda are demoted to the user/untrusted channel. That is: system's LOCKED prefix is byte-identical to the no-addendum case.
5. **Projection failure is fail-closed.** If the encoder/projection throws a typed error, this hop sends no model request and does not fall back to "ship the dirty transcript as-is".
6. **The read rule changes to "trust only this hop's host frames"**, no longer declaring the newest XML tag in the transcript authoritative.
7. **Once the capability lands, a one-line product intro goes into the root `README.md`'s Features** (peer of Harness / Tools / Surfaces), without touching the READMEs under `docs/` or `web/`.

**ADR relationships:** 0009 / 0028 / 0044 are not rewritten; this generalizes and welds their "the channel is the trust" rulings into one unified mechanism for the instruction surface. 0028's bar-projection discipline (append-only, never into system) is carried over verbatim.

## Why not

- **Labeling / parsing an XML roster as anti-forgery:** ADR-0009 already ruled "labeling is not a defense"; the roster syntax itself is a forgeable plate with zero forgery cost. Rejected.
- **Full CaMeL (privileged LLM extracting control flow):** out of scope — that requires rebuilding the entire data-flow permission lattice, far beyond what removing the fake plate needs. This ADR neither promises nor reserves it.
- **Soul admonition as mechanism:** an optional one-line usage hint is fine, but it carries no invariant — admonition is a re-skin of "behave", exactly the status quo being vetoed. Rejected as an acceptance mechanism.
- **Stuffing per-hop freshness into system:** breaks KV prefix stability and violates 0028's contract that the bar never enters `deps.system`. Rejected.

## Consequences

- **KV prefix stability**: projection is a pure function; wire bytes only append as history grows and never drift with assembly timing.
- **Disk may be dirty, the wire is a derived view**: fake tags remain verbatim in the authoritative transcript (audit and reproduction unaffected); only outbound bytes are transcoded — isomorphic to the observability side-channel / Contract X.
- **Does not replace the sink layer**: a "go do X" inside an ordinary sentence may still be executed by the model; instruction authority and capability authority are two layers — permissions, the sandbox, and egress remain the enforcers of the capability surface. Removing the fake plate ≠ immunity to natural-language indirect injection.
- Landing surface: `src/harness/model-adapter/` (the outbound seam deepens into a projection), `src/harness/loop-engine.ts` (host-injection commit stamping), `src/harness/subagent/worker.ts` (constitution vs addendum), the read-rule constants and the golden set, and the root README Features line (ordered after the capability lands).

## Evidence pointers

- `specs/instruction-authority-projection.md` Settled invariants 1–6.
- ADR-0009 (labeling is not a defense), ADR-0028 (the bar goes into messages, not system), ADR-0044 (low-provenance sources do not buy a system seat), ADR-0036 (on-disk source of truth ≠ model-visible bytes).
