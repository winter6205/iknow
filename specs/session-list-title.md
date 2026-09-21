# Spec: Session list title (lite-generated)

The session list shows a topic label per row, not a compressed summary. The placeholder is a truncation of the first user message; when a lite model slot is configured, the title is generated once in the background and persisted as a standalone transcript event.

## Does

- TUI `/sessions`, the Web sidebar, and the HTTP list all read the header `title` (cached).
- No title event: `title` = `extractTitle` (first user message with text, trim + 80).
- Title event present: `title` = the latest event's body; save / compact no longer overwrite it back via `extractTitle`.
- When `settings.llm.liteModel` is a valid `provider/model` and the first `StopReason=completed` arrives: complete once without tools; on failure keep the placeholder.
- Small talk (gated by the same "is not small talk" check as `shouldSeedTaskFocus`) does not burn a lite call on its own; if the input is too short, wait for an existing assistant turn before generating.
- `lastFinalText` remains searchable but is not displayed as the main row text.

## Does not

- Use `title` as a folder name or worktree slug.
- Treat the full compact summary as the list name.
- Switch compact / memory extract / dream to the lite model.
- Let humans rename sessions (slash command, sidebar click, HTTP PATCH). The title comes only from placeholder truncation or lite generation.
- Repeated mid-session retitling, two-row list entries, topic clustering.
- A second provider table; refuse to start when lite is absent.

## Contract

- The title event does not enter `messages` or the model prior.
- lite uses the user settings; the project file's `llm` section is still discarded.
- A missing main model still triggers ADR-0015 fail-fast.

Basis: wayfinder **Session-list conversation summary (decision)** G1–G4; ADR-0113 (proposed).
