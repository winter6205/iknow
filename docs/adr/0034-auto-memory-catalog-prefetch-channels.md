# 0034. Auto-memory read path — catalog in system, prefetch on the user turn, low-trust labels

Date: 2026-08-28
Status: accepted

> **Amendment 2026-09-04**: the existence pointer may only declare that the store exists — it **must not** order the model to `Use memory_recall`. The catalog discipline sentence must state that the catalog is an index, not a to-do list, and that a title colliding with the user's words does not make recall mandatory. The prefetch channel is unchanged. `memory_recall`'s default hit count moves to 3; the tool description must not say "at the start of a task". D1–D3's channel shape (catalog into `system`, bodies not into `system`, prefetch into the user message, recall returning verbatim entries) stood unchanged at this date.
> **Amendment 2026-09-05** (ADR-0044): D4 withdrawn. Qualified promoted bodies no longer enter `system`. D1's catalog channel is untouched by this vote.

## Context

ADR-0009 D3 put un-promoted auto memory on `memory_recall` / `tool_result` only, with a one-line existence pointer in `system`. After extract (ADR-0031) the store can fill while the model still never sees a directory, so it rarely calls recall. Putting changing per-turn bodies in `system` would break the KV-cache prefix (ADR-0009 D6). Treating extracted notes as instructions would let stale text steer the agent.

## Decision

1. **Catalog in `system`, bodies not.** When `autoExtract === true` and at least one live entry exists, `memory_layer` may append a capped catalog of live titles/hooks plus a fixed English disclaimer. Un-promoted entry **bodies** still must not enter `system`. This amends ADR-0009 D3's "existence pointer, nothing more" only for that catalog + disclaimer.

2. **Prefetch rides the user turn.** Each turn may attach at most five scored live bodies to the **user** payload (not `deps.system`). Scoring is `scoreMemoryEntries`; zero lexical hits are ineligible. The block is labeled advisory and time-sensitive.

3. **Recall still returns full hits.** Default **three** hits (was ten; amended 2026-09-04) remain title + frontmatter + body, not catalog lines. Same advisory label. Auto-memory must not auto-promote and must not outrank the user turn, the repository, or project instructions. The existence pointer must not command the model to call `memory_recall`.

4. **Promote assembly shares the catalog gate.** ~~Eligible promoted bodies may enter `system` only when `autoExtract === true` (same as catalog).~~ **Superseded by ADR-0044:** promoted bodies never enter `system`. `AGENTS.md` / existence pointer / `memory_recall` / `memory_save` do not follow the catalog gate. `MEMORY.md` is never injected. Amendment 2026-08-29.

## Consequences

- (+) The model can see that a library exists without reloading bodies every turn; prefetch can change without busting the system prefix.
- (−) A stale catalog line can still hint the model to recall a bad note. Accepted: channel and English disclaimer keep it non-authoritative. Body-in-system via promote is withdrawn (ADR-0044).

## Why not

- **Prefetch or un-promoted bodies in `system`:** breaks prefix cache and raises trust.
- **Catalog-only recall (ten index lines, no bodies):** forces a second fetch for every useful hit.
- **Default ON / auto-promote:** would let unverified extract dominate the agent.

## Evidence pointers

- ADR-0009 D3 / D6; ADR-0031 D3 / D5
