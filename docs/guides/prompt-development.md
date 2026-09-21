# Prompt development guide

Read this when changing any text or assembly the model sees: tool descriptions, soul / usage, extract / dream / research-track instructions, the system prefix, tool schemas, overflow eviction. This guide covers how to change and how to verify, not prompt content itself. Terminology follows `docs/CONTEXT.md`; scope is limited to the artifacts listed above.

Golden fixture: one fixed input plus a decidable trajectory. Golden set: the group of fixtures for one locked behavior, stored next to that behavior.

## Principles

1. **Instructions are not gates.** If code, schema, or tool trajectories can decide whether the model should act, don't rely on prompt text alone. When a discipline sentence can't hold a behavior, add a hard gate — don't grow the system prompt.
2. **Short instructions, deep context on demand.** The system prompt is a map (identity, boundaries, available tools), not an encyclopedia. Material needed only for this turn (retrieve payloads, short **memory prefetch** lines) belongs on the user side or in tool_result, never in the resident prefix.
3. **Keep the prefix stable.** Identity / soul / **memory existence pointer** / tool schema stay byte-stable within a session. Memory, time, and hit lists that change every turn must stay out of this prefix, or the cache breaks and the model fixates on a shifting booklist.
4. **Prompts are versioned artifacts.** Changing wording is a new version, and it counts as done only after passing the same golden set. No merging on the basis of a couple of tweaked sentences and a glance at the output.

## Three-layer assembly

| Layer              | Content                                                                            | Volatility                 |
| ------------------ | ---------------------------------------------------------------------------------- | -------------------------- |
| System prefix      | agent identity, agent soul, usage, user profile, existence pointer; corpus lists / full-library catalogs do not go in this section | as invariant as possible within the session |
| User side, this turn | **memory prefetch** (0–3 index lines), this turn's user text                       | varies per turn            |
| Tool results       | retrieve / `read_file` / `memory_recall` payloads                                  | appear per call            |

Memory narration never counts as a citation. Numeric and archive claims are accepted only from retrieve / `read_file` trajectories plus the citation verifier.

## Workflow for changing prompts

1. **Fixture first, wording second.** One golden input per behavior point: expected structure (JSON fields), expected tools present/absent, expected prefetch line count. When an incident recurs, fold that input into the set to lock out regression.
2. **Hard gates before soft scores.** Hard: JSON schema, prefetch 0/≤3 lines, no full-library catalog in system, retrieve present in the research track, verifier not fed memory payloads. Soft: an LLM judge only scores; it never gates alone.
3. **Evaluate extract / dream models separately from the chat model.** An extract model must not grade its own candidates ("this extraction is good"). The rule half is tested with fake models / fixtures; the real model is only tested on whether "keep / reject" lands on the fixture labels.
4. **Change one variable at a time.** Don't swap the model, the extract prompt, and the prefetch cap in the same PR; otherwise a regression can't be attributed to a layer.
5. **Keep wording and gates in the same repo.** Functions like `buildExtractPrompt` export or pin their strings; tests assert the key discipline sentences remain. Vetoes that can match by token overlap go in code — never leave the only veto in the prompt.

## Roster: which surfaces have sets, which are registered gaps

**Rule: golden sets live with the behavior they lock — no central dump folder. A surface without a set must either gain one or register the gap; a bare Not run is not enough.**

Reason: when a set sits beside the wording it locks, whoever edits the wording sees the set in the same place; centralizing would create a second address to keep in sync. The fixture paths in the table below are enough — what's missing is **registration**, not a directory.

**Three lock tiers** (so unit tests aren't mistaken for sets):

- `STATIC` — asserts the constants/substrings are still present.
- `SEAM` — asserts inject-vs-not, in-system-or-not, byte constancy.
- `trajectory set` — fixed input + decidable first tool / trajectory. **Only this tier is a golden set.**

| Surface | SSOT source | Lock | Set path (trajectory sets only) |
| ------- | ----------- | ---- | ------------------------------- |
| tool description | each `src/harness/aci/tools/*.ts` (graph and subagent tools excepted) | STATIC (description guard + per-tool) | Only the two web tools and run_graph have trajectory sets. `grep` / `read_file` / `edit_file` / `write_file` / `read_image` are **registered, not built** (their changes are deterministic contract statements, not tool-choice divergences; covered by the description-guard STATIC lock + schema assertions). `grep` has a registered gap: adding a `files_with_matches` alias to the schema enum and listing legal values in the failure message — a pure value-set extension with clearer errors, no new branch or tool-choice divergence, so a trajectory set isn't worth its cost. `todo_write` has a registered gap: the description splits four modes and schema field descriptions bind them (deletion goes through update, replace takes items only) — a pure instruction rewrite, no new branch or tool-choice divergence, so a trajectory set isn't worth its cost. |
| web discover vs read | `web-search.ts` / `web-fetch.ts` | STATIC + trajectory set | `tests/harness/aci/tools/web-discover-vs-read.fixtures.ts` |
| graph notification text | `graph/notification.ts` | STATIC + SEAM + trajectory set | `tests/harness/graph/graph-mode-notification.fixtures.ts` (SEAM lock = `graph-mode-presence.test.ts`) |
| graph tool choice | `graph/run-graph-tool.ts` | STATIC + trajectory set (same set as above) | same set (locks the run_graph side — the two rows share one fixture set) |
| soul / usage | `identity/soul.ts` / `identity/usage.ts` | STATIC + SEAM | **Gap** |
| extract prompt | `memory/ingest.ts` (`buildExtractPrompt`) | STATIC | **Gap** (discipline sentences locked, behavior has no set) |
| dream prompt | `memory/dream.ts` | cap only | **Gap** (body unlocked) |
| system prefix assembly | `identity/assemble.ts` | SEAM (order + byte constancy) | n/a (assembly is SEAM-locked; no trajectory set needed) |
| tool schema | `aci-registry.ts` / `build-engine.ts` | SEAM | n/a |
| overflow eviction | `aci/tool-overflow.ts` | STATIC + SEAM | n/a |
| `<agent_status>` | `agent-status.ts` / `agent-status-instruction.ts` | STATIC + SEAM + trajectory set | `tests/harness/agent-status-instruction.fixtures.ts` (STATIC lock = `tests/harness/agent-status-instruction-golden.test.ts`; SEAM lock = `agent-status-instruction-bar.test.ts` + `agent-status-reconcile.test.ts`; real-model half = `archive/tests-real-llm/agent-status-instruction-echo.test.ts`) |
| MCP reconnect notice | `loop-engine.ts` | STATIC + SEAM | **Gap** |
| memory prefetch | `memory/prefetch.ts` | STATIC + SEAM | **Gap** |
| subagent persona | `subagent/worker.ts` | SEAM | **Gap** (the dispatch lesson in the `spawn_subagent` description belongs to this surface too: the STATIC locks in `tests/subagent/spawn-subagent.test.ts` and `tests/harness/aci/tools/d9-description-guard.test.ts` pin its four disciplines; trajectory set registered-not-built — the lesson is a discipline statement, changes no tool-choice branch, no behavioral divergence) |
| skill body loading | `aci/tools/skill.ts` | STATIC + SEAM | **Gap** |

**How to handle gaps (the reason this table exists):** when a surface on a **Gap** row changes, pick one of two paths; ending with a bare Not run is not allowed:

1. **Build the set** — following the workflow above, write fixtures first (offline half + real-model half), go green, then change the wording; backfill the set path into this table.
2. **Register, don't build** — in the commit body of the change, write "registered gap: <surface> has no trajectory set because <cost / no behavioral divergence>" and leave a trace on this row. The gap then shifts from "rediscovered every time" to "a settled conclusion".

**Trajectory sets must run a real model.** Running only the offline half proves just the fixture shape; first-tool decisions must pass `npm run test:real-llm`. Missing key → record Not run honestly; never count offline green as set green.

## Memory surfaces

- Automatic extraction is off by default in code; this repo's project env turns it on for local evaluation. The over-attention golden set is acceptance (greeting turn with zero prefetch; assembly without a full-library booklist or promote; extract output legal and veto-class entries not stored; research track must retrieve for any number; company names in the library still search the archive; explicit remember crosses threads) — it is not a power switch.
- Tests (pytest / citation contract) run with memory off by default, even if the operator's `.env` enables it, unless the case is specifically testing memory.
- Explicit save / recall / user-profile edits can be wired ahead of this set.
- Changing extract or existence-pointer wording requires re-running the set.
- Prefetch is a DB-row projection, not an index file.

## Don't

- Don't fix over-attention by lengthening the system prompt.
- Don't treat "more recalls into system" as a reward.
- Don't write archive-answerable content into memory prompts as permitted material.
- Don't claim done on a prompt change without fixtures.
