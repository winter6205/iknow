# Spec: skill-index-increment — incremental skill model index and human-side slash unification

**Status:** ready for plan  
**Surface:** harness skill catalog / identity `<available_skills>` / loop injection seam / session persistence / TUI·Web·CLI slash / worker assembly  
**Interview:** 2026-09-17 LogicSync (assumption gates confirmed, see Inherits)

## Objective

After a session opens, **skill model index** entries that newly appear must reach the model, and the system prefix must never be rewritten. Human slash skill loading goes through the **loadable-skill surface** (which may include human-side skills without a description), and TUI / Web / CLI share **one entry**. `skill()` governs model-index eligibility only; reading a SKILL.md from disk is not blocked.

**Users:** the local operator (installing skills, slash, new SKILL.md appearing mid-session) and the model (relying on the index via `skill({name})`).

**Success shape:** the opening frozen table stays in system and is deep-equal across adjacent turns; a new model-index name is appended at the very end of messages as a hidden user message before the next model call; slash can immediately `/`-complete the new loadable entry; a spawned sub-agent snapshots the parent session's complete model index at birth into its own frozen table.

## Assumptions (confirmed in interview)

1. The opening `<available_skills>` stays frozen in system, satisfying the **prefix eligibility line**.
2. Mid-session only **appends newly created** model-index rows; no full-table refresh, no description changes to already-admitted entries.
3. Edits / removals / disable changes to admitted entries: not reconciled in this session — **start a new session** to refreeze.
4. The slash envelope injecting the body ≠ index admission; the next turn may still add the index increment for that name.
5. Admitted names persist with the **session** (the **index entry history**); **compact does not** re-attach a listing based on it.
6. New deltas **carry the full description**; the opening 10% **index downshift** is not re-run.
7. Sub-agents do not follow increment messages and keep no second diff; spawn inherits the parent session's **complete model-index snapshot at that moment**.
8. The delta attaches at the **end** of messages (this turn's user message / skill-load envelope is already above it).
9. Plugin packages and MCP: only an **explicit reload or a new session** makes the scanner see them; no automatic pre-turn diff. After reload, extra **skill model index** names still go through the same delta path (system unchanged). The MCP tool surface is not covered by this listing.
10. Automatic name-diff covers every skill root of the current `scan()` (plugin roots must be reloaded first to enter the scan-visible set).
11. Human-side skills (no description, or `disable-model-invocation`): enter slash, not the model index; `skill()` rejects them; **reading the file is not blocked**.
12. This slice does not turn the MCP name catalog into a skill-like increment.

## Boundaries

- **Does:**
  - Split the catalog cleanly into **skill model index** vs **loadable-skill surface** (`get` still fetches entries by name, including disabled).
  - Opening frozen table = the model index's assembly-time projection + the existing downshift; this system segment is unchanged within the session.
  - Before sending to the model: rescan current skill roots → model index − entry history → render only new rows as an `<available_skills>` delta, hooked to the messages tail via pendingInjected in the same shape; persist the entry history.
  - The human-side catalog rescans **at the moment** of install / folder drop / reload, so slash sees new entries immediately.
  - TUI / Web / CLI slash is **one entry**: the full loadable set, `SkillCatalog.get` semantics, remainder by input token, aliases; the HTTP DTO allows a missing description.
  - `skill()`: non-model-index eligibility → reject, do not inject the body; `read_file` is not prohibited.
  - Hidden predicate: the delta user message does not enter the ❯ bubble / Web user bubble / CLI ↑ history (same discipline as `isTuiHiddenUserMessage`).
  - worker spawn: write the parent session's full model-index set into the worker's own system frozen table.
- **Confirms with human:** (none — interview closed)
- **Out of this spec:**
  - MCP tool-catalog increments, MCP automatic name-diff.
  - Automatic admission of plugin packages before reload.
  - Re-attaching the listing after compact or re-attaching invoked skill bodies (bodies still per ADR-0079).
  - Hot-updating descriptions of admitted entries, invocation-count-based downshift, diagnostic slash (`/context`-style), `paths` / `when_to_use` / sub-agent startup preloading of SKILL bodies.
  - Changing the six segments of `IKNOW_ASSEMBLY_ORDER`; moving the opening listing out of system.

## Success Criteria

- **SC1** Adjacent turns (no new model-index names) keep `tools` + `system` deep-equal, and the `<available_skills>` frozen table byte-unchanged.
- **SC2** After adding a skill **with a description and not disabled** under current scan roots, the **last** user text in the messages sent to the model on the next turn is `<available_skills>` containing **only** that new name (with its then-full description); the frozen table does not contain that row.
- **SC3** The same new name is not appended a second time; after session restore the entry history still prevents duplicate appends.
- **SC4** After compact, do not re-append the same batch of names because "the increment disappeared from messages".
- **SC5** A skill without a description: slash (TUI/Web/CLI, same entry) can load it via the envelope; it appears in neither the frozen table nor a delta; `skill({name})` rejects it; `read_file` of its SKILL.md does not fail because of this gate.
- **SC6** `disable-model-invocation` with a description: same as SC5 — human side can `/` it, model index and `skill()` reject it.
- **SC7** After slash loads a new skill body, if the name has not yet entered the model index, the next turn still appends the delta (envelope ≠ entry history).
- **SC8** At install / reload time, slash candidates already include the new loadable entry, without waiting for the next turn.
- **SC9** Web `listSkills` (or its successor DTO) includes entries without descriptions; remainder is not mis-cut by canonical name length.
- **SC10** The spawned worker's system contains the parent session's full model-index set at that moment (including names already admitted via increments); the worker does not copy the parent's increment messages into its own prior.
- **SC11** Without a reload, plugin-package / MCP-config changes alone do **not** produce a skill-index delta.
- **SC12** This slice's relevant `npm test` paths (catalog two surfaces, skill tool gate, unified slash entry, injection hiding, entry history, worker snapshot) exit 0.

## Input-contract classes

| Surface              | empty                                        | invalid/negative                          | overflow                              | concurrent                                     | exception                                                            |
| -------------------- | -------------------------------------------- | ----------------------------------------- | ------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| model-index query    | no eligible entries → frozen table keeps its existing empty-list line | disable / no description → not in the index | downshift still only applies to the opening frozen table | multiple diffs in one turn append the new set once | rescan failure → typed error; frozen table unchanged, no partial delta appended (EXIT: entry history preserved) |
| loadable surface / slash | `/` non-skill                            | unknown name → not skill-load; static vocabulary wins first | N/A | N/A | body read failure → existing skill-load error, no fake admission |
| `skill()`            | empty name → existing validation             | non-model-index → reject, no body injection | second short-circuit still ADR-0079   | N/A                                            | disk read failure typed, distinct from "eligibility rejection"       |
| index entry history  | new session = frozen-table name set          | writes of unknown names ignored           | N/A                                   | append and persist in the same beat            | persist failure → typed; do not treat a messages append as already admitted |

## Open Questions

(none)

## Inherits / Changes

**Inherits (CONTEXT original wording, meaning must not change in implementation):**

- **Prefix eligibility line:** in-session mutable gates may only land at the messages tail or the handler layer.
- **append-only messages:** messages are only ever updated by immutable append.
- **progressive disclosure / direct-call loading / index downshift / overflow governance:** the opening index and the 10% gate; with a description, `skill({name})`.
- **skill() second short-circuit / skill-load display projection / skill bare alias:** the gate only covers `skill()`; the slash envelope still injects the full text; resolution asks the catalog.
- **session transcript / conversation folder:** entry history follows the session; no second authoritative messages source.

**Inherits (ADR):** ADR-0043 prefix freeze and the messages-side gate; ADR-0046 opening downshift and direct call; ADR-0079 `skill()` short-circuit and the non-short-circuiting slash; ADR-0095 plugin skill discovery (this slice: package activation relies on reload).

**Amends:** `specs/tui-skill-slash-catalog.md` scoped CLI out — this spec **reclaims** CLI, sharing one slash entry with TUI/Web. The catalog.get / remainder / static-priority / agents-not-in-slash locks of `specs/tui-skill-slash-catalog.md` **remain valid**.

**Changes:** add ADR-0098 (opening frozen table + messages delta + index entry history). Split the catalog's ambiguous `available()` into a model index and a loadable surface.

## ACR

```
bounded-context-guardian: yes — catalog/entry-history/injection live in harness; hosts only consume the unified slash projection; the session-api DTO is the HTTP shape of the same loadable surface, no second eligibility gate in web
input-contract-tests: yes — the five classes above cover the two queries, skill(), slash, entry history, empty injection set
error-handling-enforcer: yes — rescan/persist/eligibility-rejection typed separately; failure keeps the frozen table and never marks a failed append as admitted (EXIT written on the entry-history row)
complexity-anti-drift: yes — reuse pendingInjected / hidden predicate; two queries instead of a third listing subsystem; MCP not merged into this channel
minimal-change-verifier: yes — only the skill model-index increment + one human-side slash entry + skill() eligibility rejection; diagnostics surface, paths, MCP catalog increments, body sampling strategy all scoped out
```

## Persist

Already flushed: ADR-0098, four CONTEXT.md entries plus vs sections, the CLI pointer in `specs/tui-skill-slash-catalog.md`, the current-status line in `docs/STATUS.md`.
