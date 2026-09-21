# 0105. Egress credential sentinel substitution: real values never enter the fence; the proxy swaps fake→real only for allowlisted domains

Date: 2026-09-19
Status: accepted

> **Scope (ADR-0107)**: once the proxy gate is restored this decision is technically landable, but **0107 does not auto-enable the sentinel**. It was once marked superseded by 0106; 0106 has since been voided. The live enablement posture is carried by the "Egress credential-sentinel posture" row in docs/STATUS.md: credential-sentinel is enabled by default upon the contract spec's merge, and the enabling body is this ADR's landing — not automatic enablement per ADR-0107 §8.

## Context

ADR-0104 opened up the data plane (the preset-allowlist tier), leaving the credential-surface posture undecided. The existing **secret-roundtrip mask** only protects the **visibility surface**: real values live inside the fence (restored at execution time) while the model-visible surface (tool output / trace / echo) is masked — it cannot stop in-fence code from "using the credential without ever seeing it": smuggling a real value out through any data exit on an allowlisted domain (gist / repo / issue) never passes through a model-visible output, and the domain allowlist cannot prevent "abuse of an allowlisted domain" (same family as ADR-0097's admission that domain fronting is unpreventable). A measured incident (2026-09-18, conversation `ee13c787`) confirmed the genuine in-fence credential need of `gh` / git push: if HTTP-family credentials enter the fence in real form, combining them with allowlisted domains yields a complete exfiltration channel.

## Decision

The egress credential posture adopts **sentinel substitution** (HTTP(S)-family credentials: `GH_TOKEN`-style env vars and credential-file forms):

1. Inside the fence there are only **fake values (sentinels)** — byte strings matching `[a-z0-9_-]` exactly, able to pass through JSON / form-urlencoded / multipart / XML verbatim (host-side pure byte scanning suffices to locate them; no request-format parsing needed). JWT-shaped credentials get a same-shaped fake minted (extraction pattern + structural validation to avoid hitting random base64 by mistake).
2. Real values exist only in the host-side egress proxy; **at the exit, fake→real substitution happens only for allowlisted domains** (header substitution + streaming body substitution; the body is never fully buffered — memory is bounded by a single chunk plus the sentinel-length holdback).
3. The substitution direction is always **fake→real**: any missed substitution (compressed bodies, base64 wrapping, splitting by an encoder) = the fake value reaches the API unchanged = authentication failure, **never a real-value leak** — the failure direction is designed in.
4. The proxy needs **TLS termination** (mitmCA) to see request plaintext; in-fence clients trust the proxy CA via environment injection. The mitmCA / sentinel / body-substitution modules are all ready-made parts of the pinned dependency `@anthropic-ai/sandbox-runtime` — no new third-party dependencies (node-forge is already on the module load graph, per ADR-0097's measured record).
5. **SSH credentials are out of scope for this decision**: private-key readability and the `SSH_AUTH_SOCK` form belong to the egress ssh bridge (an ADR-0097 form extension); the posture of keys entering the fence keeps the "egress-domain restriction as backstop" rule (a key can only be used to authenticate toward allowlisted domains).
6. The existing secret-roundtrip mask (visibility surface) is **kept**; the two layers coexist and do not replace each other: the sentinel governs the **presence surface**, the mask governs the **visibility surface**.

## Why not

- **Real values in the fence + output masking (extension of the status quo)**: the mask guards the model's eyes, not the hands of in-fence code; real value + allowlisted domain = the exfiltration channel is always there. Rejected.
- **Credentials never enter the fence (API operations such as PR creation stay host-side, done on the agent's behalf)**: evasion rather than resolution — the agent cannot self-serve API-type operations inside the fence, and the unattended form is out of the question. Acceptable as a transitional form before the ssh bridge and sentinel layers land, not as the end state. Rejected.

## Consequences

- TLS termination is a new trust surface: CA private-key generation / permissions / lifecycle and the scope of re-signed certificates (allowlisted domains only?) must be nailed down by the spec; in-fence clients that do not trust the proxy CA (hard-pinned certificates) show up as connection failures — fail-closed.
- Non-substitutable forms (e.g. `Content-Encoding` request bodies) degrade to authentication failure with a warning — the fail-safe direction, accepted.
- The credential-file form needs a startup flow of "host reads the real value → mints the sentinel → generates a masked version of the file and binds it into the fence"; real-value files never enter the fence.
- Boundary with the secret-roundtrip mask: sentinel fake values are not secrets and must not trigger the mask recognition layer; double substitution must be prevented by a spec nail.
- The reason LLM API domains stay out of the preset tier (ADR-0104) still holds under this decision and is stronger: even if they were allowlisted in the future, model-provider keys should also go through the sentinel rather than real values in the fence.

## Evidence pointers

- Reference implementations inside the pinned dependency package: `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/body-substitution.js` (streaming fake→real + failure-direction comments), `credential-decode.js` (JWT extraction / validation / same-shaped fake minting), `credential-sentinel.js` (`SENTINEL_PREFIX`), `http-proxy.js` (SentinelRegistry header substitution; SSH exception note at `:271`), `mitm-ca.js`.
- Conversation `ee13c787` transcript (2026-09-18): `gh auth status → X Failed to log in` (the real in-fence credential need).
- `docs/adr/0097-*.md` §Trade-offs (domain fronting unpreventable); `docs/adr/0104-*.md` (same logic: "a key inside the fence + preset tier = a direct secret-transit channel").
- `docs/CONTEXT.md` "secret-roundtrip mask" (the current visibility-surface state).
