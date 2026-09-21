# 0113. Session list titles: a standalone transcript event + lite model

Date: 2026-09-19
Status: proposed

> **Carrier note**: the settings-routing consequence of this decision is already carried by ADR-0015's Amendment 2026-09-19 (main-session `settings.llm.model` fail-fast unchanged; optional `settings.llm.liteModel` is a separate field). The live contract is `specs/session-list-title.md`.

## Context

List rows today rely on `extractTitle` (first user message trimmed + 80) written into `SessionFileV1.title`. The TUI already renders that field, but pleasantries, half-finished operation scripts, and compact preambles all become list names; and every save / compact recomputes it, with no gate on the generated result. The main session has only `settings.llm.model` (ADR-0015); routing title generation through the main model would drag it into Loop Engine's expensive path. It also needs separating from compact's LLM summary (`title` is not a compaction summary).

## Decision

1. **Title authority is a standalone transcript event** (a JSONL type alongside `message`, named by this repo). The header `title` is only the cache for `GET /sessions` / TUI / Web: it equals the body of the latest title event; only when no event exists is it the `extractTitle` placeholder.
2. **Generation lives in its own module**: a single tool-free text completion, not through Loop Engine, never blocking the main turn. The host fires it fire-and-forget after the first `StopReason=completed` once substantive user text exists; failures are silent and the placeholder stays.
3. **`settings.llm.liteModel`**: a user-level `provider/model` route shaped the same as `llm.model`, going through the same `providers[]`. Absence or a failed call does not fail-fast. This ADR authorizes **session title generation** only as the consumer of that slot; compact / memory extract / dream do not change routing.
4. Once a title event exists, `extractTitle` and compact must not write back into the header `title`. No command or UI is offered for humans to rename a session.
5. The primary text of the three list surfaces aligns with the cached `title`. `lastFinalText` is for search only and does not enter the row.

## Why not

- **Keep truncating the first user message:** the TUI has shown that being wired in does not make the list scannable.
- **Use the compact summary as the list name:** the two semantics have been separated.
- **A second provider set / global apiKey:** would duplicate the ADR-0015 registry.
- **fail-fast when lite is absent:** the title is an enhancement, not a main-session precondition.
- **Letting humans rename sessions:** the list title is a machine-generated scanning label, not a user-facing asset name. Rejected.

## Consequences

- The JSONL parsing union must recognize the title event; the unknown-type discipline aligns with the existing unknown-field strategy, and the title event must never be projected into `messages`.
- ADR-0015's rule that "`settings.llm.model` is the sole source of the main-session route" still holds; lite is **a separate field**, not a replacement of model.
- Project settings still do not adopt `llm` (ADR-0084).
