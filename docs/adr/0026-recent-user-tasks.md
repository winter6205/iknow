# 0026. Compact focus retention switches to task excerpts instead of storing taskFocus in the session

Date: 2026-08-21
Status: accepted

Context: ADR-0018 made `session.taskFocus` a resident focus (seeded once from the first substantial task sentence, rendered at compact time with 240+history). After grilling it was confirmed: what the model needs is the user's own task wording as of the compression moment, not a card in the session that goes stale; filling the card every turn — and having the compression LLM fill it — each wastes a round.

Decision: compact in normal mode now extracts at-compact-time and pastes up to 3 qualifying verbatim user-task sentences from the current `messages` (task excerpts); no persistence, no seeding, and auto mode pastes none. ADR-0018's `session.goal` split and zero model writes still hold; its `session.taskFocus` residency and focus-rendering sections are void.

Why: verbatim wording is checkable against the conversation, unlike a summary card; extracting on the fly prevents card/conversation divergence; reuses `isTurnQuery` + the greeting filter, adding no model just for excerpting.
