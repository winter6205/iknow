# 0028. Status-bar append injection, never replace the history strip

Date: 2026-08-23
Status: accepted

> **Superseded clause (ADR-0085 / 2026-09-11)**: the two in-text claims "`todo_write`'s add/check/list unchanged" are outdated — the main path is now the three verbs **add / update / read** (`check` folded into update, `replace` demoted to a whole-table escape hatch), with stable ids on entries. The strip's projection discipline (project only unfinished items, append never replace) is unchanged; read that half-sentence per ADR-0085.

> **Amended clause (ADR-0103 / 2026-09-19)**: the Consequences line "live fields are only `last_tool` + a todo section that appears only when unchecked items exist" is amended — the field set gains an `instruction:` segment (verbatim echo, truncated, of the latest user instruction's first line, computed by code with no summarization) plus a one-shot pivot-reconcile marker after a new user message lands; the ban on "copying task excerpts into the strip" stands (the instruction echo is verbatim, not semantic extraction). The injection discipline (append before every model hop, append-only, never replace) is unchanged verbatim.

## Context

The status strip shown to the model (a live snapshot computed by code) must enter the request. The candidates: replace the last strip every turn, or append it like a normal message. Replacement looks like "always exactly the latest state", but it rewrites a prefix that was already sent — hostile to the KV cache and in violation of append-only messages (when something is wrong you write another one, you never evict the old entry).

The read rule "the last one is authoritative" is static: it can live in the system prompt, or be printed on every strip.

## Decision

The status strip is appended as a **user** message at the end of the current `messages` **immediately before each model call** (including the tool loop within the same user turn); old strips stay in the transcript. No splicing out of historical strips before sending. Not written into `deps.system`. The UI reads only the newest snapshot and keeps no separate ledger.

The read rule is written into the system prompt once, not onto every strip. Changing reminders (mode, date) go through the strip or user-side reminders later, never by mutating `system`.

The todo section is present only when unchecked items exist: write it into the strip only when `- [ ]` is present, and project only those unchecked lines; absent / empty / all-checked means the whole section is absent. `todo_write`'s add/check/list unchanged (read per ADR-0085 — see the superseded-clause note above); skip conditions live only in the tool description.

## Why

Prefix stability is what reuses the cache; in long tasks, recomputing less prefix usually beats saving a few strips' worth of text. The live state is expressed by "the newest strip", not by rewriting history. The rule is invariant, so putting it in `system` does not break the prefix; the strip carries only facts.

## Consequences

Live fields are only `last_tool` (the tool that just completed on the previous hop; idle if this turn has run no tool yet) + a todo section **that appears only when unchecked items exist**. The todo section projects only the `- [ ]` lines from `todos.md`; when the file is absent, empty, or left with only `- [x]` lines, the whole section is absent (never print an empty list, never carry checked items into the strip). Task excerpts, cwd, and skill/MCP indexes are not copied into the strip. `todo_write` remains the model's self-maintained ledger (add/check/list semantics unchanged, per the ADR-0085 reading above); the strip only reads the file — the host does not build a checklist on the model's behalf and does not announce "erased" in tool results. The skip condition (don't `add` when the user's request is already done on the next step) is written only in `todo_write`'s tool description, never in the strip and never as a vague "simple tasks" ban. In-flight state goes only to TUI side products, never into the model strip.

Within one hop the model can edit the ledger while running other tools: the new strip is recomputed from the post-tool file **before the next** `adapter.step`, not mid-hop during reasoning.

- The system prompt gains one stable reading-rule sentence whose bytes should not change across turns.
- Each `<agent_status>` contains no policy prose, only code-computed live state.
- The TUI display side projects at most 4 unchecked lines and discloses the overflow count in a footer; this is a display-side defense line — hard caps on entry count/length at the ledger write path are handled separately (outside this ADR).
- If weak models ignore that one system sentence, re-evaluate adding a fixed short pointer at the strip's end, rather than reverting to replacing history.
