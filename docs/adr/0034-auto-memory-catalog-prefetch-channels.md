# 0034. Auto-memory read path — catalog in system, prefetch on the user turn, low-trust labels

Date: 2026-08-28
Status: accepted

## Context

ADR-0009 D3 put un-promoted auto memory on `memory_recall` / `tool_result` only, with a one-line existence pointer in `system`. After extract (ADR-0031) the store can fill while the model still never sees a directory, so it rarely calls recall. Putting changing per-turn bodies in `system` would break the KV-cache prefix (ADR-0009 D6). Treating extracted notes as instructions would let stale text steer the agent.

## Decision

1. **Catalog in `system`, bodies not.** When `autoExtract === true` and at least one live entry exists, `memory_layer` may append a capped catalog of live titles/hooks plus a fixed English disclaimer. Un-promoted entry **bodies** still must not enter `system`. This amends ADR-0009 D3's "existence pointer, nothing more" only for that catalog + disclaimer.

2. **Prefetch rides the user turn.** Each turn may attach at most five scored live bodies to the **user** payload (not `deps.system`). Scoring is `scoreMemoryEntries`; zero lexical hits are ineligible. The block is labeled advisory and time-sensitive.

3. **Recall still returns full hits.** Default ten hits remain title + frontmatter + body, not catalog lines. Same advisory label. Auto-memory must not auto-promote and must not outrank the user turn, the repository, or project instructions.

## Consequences

- (+) The model can see that a library exists without reloading bodies every turn; prefetch can change without busting the system prefix.
- (−) A stale catalog line can still hint the model to recall a bad note. Accepted: channel and English disclaimer keep it non-authoritative; promote stays the only body-in-system path.

## Why not

- **Prefetch or un-promoted bodies in `system`:** breaks prefix cache and raises trust.
- **Catalog-only recall (ten index lines, no bodies):** forces a second fetch for every useful hit.
- **Default ON / auto-promote:** would let unverified extract dominate the agent.

## Evidence pointers

- `specs/auto-memory-low-trust-read.md`
- ADR-0009 D3 / D6; ADR-0031 D3 / D5
