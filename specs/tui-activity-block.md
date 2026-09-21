# Spec: tui-activity-block — TUI activity blocks (shared body slot for thinking and quiet tools)

> Input = the interview plan (ACR 5/5 yes; 8 interview-locked sentences; this worktree flushes `docs/CONTEXT.md` together with the plan persist).
> Revision = live-signal plan (locked sentences 1–9; supersedes "live quiet = retract everything", locking in the **live noise vs live signal** split and the `web_search` / `web_fetch` solid cards; the Locked sentences section below is the current contract, the Live-signal revision section is the revision layer).
> Revision 2 = thinking-at-bottom plan (locked sentences 1–6; supersedes Live-signal locked sentence 1's "thinking is always drawn **above** the actions it drives", re-pinning **live thinking at the very bottom / in-place `Thought for` / sink order matching the timeline**).
> Scope = TUI process chrome is cut into **activity blocks** per assistant message; a pure derivation module produces the block list and ChatView only consumes it; no Ctrl+O changes, no `thinkingMs` persistence changes, no harness tool-shape changes, no web changes.
> Landing = T1 this spec → T3–T7 implementation (TDD) → code-review → verification-before-completion.

## Objective

Replace TUI's "one convergence per turn" process chrome with a tense model **cut into blocks per assistant message**: at most one activity block per message, each block holding one title line + one body slot, the slot handing off between "thinking stream" and "one dim quiet-tool preview line"; blocks append chronologically, and intermediate body text breaks the weld.

**User**: iknow is a single-user, single-project local product; the TUI is the main acceptance surface (`npm run dev:tui`).

**What to build**:

1. **Pure derivation module** (no React): `messages + live runs → activity blocks`; the block list is the single source of truth for process chrome.
2. **Converged consumption**: ChatView consumes the block list; the old dual summarizers (the live-activity-group present-tense line and the unit-fold end-state line) no longer draw the same retract batch simultaneously.
3. **Slot handoff**: thinking still streaming → slot belongs to thinking; quiet tools take over → slot belongs to the one-line dim current preview; all quiet tools finished → preview retracted, title turns `called`.

**Success shape**: in one real session, the sequence thinking → quiet tools → body → quiet tools appears on screen as "block titles evolving segment by segment + slot handoff", with no second present-tense summary line in parallel and no whole-turn one-line stub.

## Locked sentences

Eight locked sentences (contract frozen for this slice; implementation and review both defer to them):

1. One assistant message yields at most one activity block; blocks append chronologically; collapsing a whole turn into one stub line is forbidden.
2. An activity block = one title line + one body slot; at any moment the slot belongs either to the thinking stream or to a one-line dim tool preview.
3. Only adjacent "thinking + quiet tools" (nothing in between: no body / keep / accent / failure) weld their durations and calling/called counts into the same title.
4. Quiet tools still running → the title uses `calling`; all quiet tools of the block finished → `called`, preview slot retracted.
5. The thinking-phase end cut = the message's first `text_delta` or `tool_call_start` (consistent with the existing `thinkingMs` measurement boundary); afterward the thinking text yields the slot and the duration stays in the title.
6. keep / accent / failure remain solid cards outside blocks; quiet tools never refresh an independent title.
7. The next thinking only opens a new block; a block already `called` (or already cut by body text) never changes its counts again.
8. Ctrl+O is not in this slice.

## Superseded

This contract supersedes the following three current behaviors (implementation must remove them together, leaving no parallel path):

| Superseded behavior                                            | Current location                                 | After supersession                                                        |
| -------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| whole-turn `unit fold` welded counts                           | `src/tui/turn-fold-lines.ts`                     | block title = that message's `thinkingMs` as `Thought for …`; `called` counts only when adjacent |
| `live activity group` and `unit fold` drawing the same retract batch at once | `src/tui/live-activity-group.ts` | live quiet tools only enter the block's body slot; settled only enter that block's `called` counts |
| tool running closes the thinking panel immediately, and thinking lines may still appear early | ChatView mutual-exclusion gate (`hideThinking` / whole-turn running) | `hideThinking` follows only **the activity block's slot owner**; a frozen stub never closes the next block's thinking slot |

**Not authorized** (explicitly excluded from this slice): Ctrl+O expansion, changing the `thinkingMs` persistence algorithm, changing the keep / accent / failure classification table, changing the non-TUI CLI surface, changing web.

## Live-signal revision (locked sentences 1–9)

The revision layer supersedes "live quiet = fold the whole current retract table into activity blocks": **what enters a block while live** is now decided by the live noise / live signal split (the settled-side retract counting is unchanged). Locked sentences follow; where they conflict with the eight above, this section wins:

1. Thinking is always drawn **above** the batch of actions it drives; after that thinking segment ends (`text_delta` or any `tool_call_start`), it turns into `Thought for Ns` **in place**, never jumping to the tail panel.
2. The block's body slot at any moment belongs only to: still-streaming thinking, or the current **noise** call's dim preview. Signal-bearing tools never take this slot.
3. Only **live noise** enters activity blocks: `grep` / `glob` / `read_file` / listing and internal queries (`tool_search`, MCP list, most LSP scans, `memory_recall`, `bash_output`, and other existing retract reconnaissance). Unregistered names still default to noise.
4. **Live signal** never enters `calling`/`called`: existing keep / accent / failure, plus **`web_search` / `web_fetch`**. Both live and settled keep a title line; search/fetch queries or URLs show as a one-line dim preview, never unfurling long text.
5. Adjacent welding only occurs between "thinking + noise" (no body text, no signal tool, no failure in between). `Thought for` must not weld on `web_search` counts.
6. Noise only, no thinking: a `calling`/`called` line alone is fine. Signal tools only, no noise: just `Thought for` (if there are seconds) + solid cards; an empty `calling` **never appears**.
7. `hideThinking` only hides thinking text that no longer owns the slot; it must never cut off assistant body text, and "any tool running" must never close the next block's thinking.
8. Keep the uncommitted under-count: noise already in the transcript but still running → block is `calling` + preview; unanchored entries dedupe by id. MessageBlocks strips only **noise**'s independent titles, not web_* / keep.
9. Ctrl+O, thinking peek line counts, changing `thinkingMs` persistence: not in this slice.

| Superseded behavior                                          | Current location                             | After supersession                                                |
| ------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------- |
| "live quiet = current retract" folding the whole table into activity blocks | derivation puts all retracts into `calling`/`called` | only live noise enters blocks; `web_search` / `web_fetch` stay solid cards |
| treating `web_search` / `web_fetch` as retract wholesale     | web_* = retract inside `TOOL_SETTLED_CLASS`  | settled still uses the retract counting basis; live keeps solid card + one-line dim query/URL |
| `liveThinking: false` / any tool running closing the thinking panel | chat-view.tsx (temporary hotfix state)       | thinking-slot sovereignty: only body or tool appearance freezes the seconds in place; a stub never closes the next segment |

**Not authorized** (revision-layer exclusions): Ctrl+O, thinking peek line counts, changing `thinkingMs` persistence, unfurling `read_file` bodies, restoring `web_search` count welding into the thinking title.

## Thinking-at-bottom revision (locked sentences 1–6)

A revision of the revision layer: the **position contract** is re-pinned to "at the bottom"; everything else (live noise / signal split, adjacent welding, `hideThinking` semantics, `thinkingMs` persistence algorithm) is inherited from the Live-signal revision. Where it conflicts with the above, this section wins — the only current locked sentence superseded here is Live-signal locked sentence 1's "thinking is always drawn **above** the batch of actions it drives".

1. While thinking is still streaming and nothing already-finished from this segment follows it yet, `Thinking…` is drawn at the very **bottom** of the transcript, so the user sees the thinking in flight.
2. After that thinking segment ends (existing cut: `text_delta` or any `tool_call_start`), it turns into `Thought for Ns` **on that same line**; newly appearing tool cards or body text append **below** it. A still-streaming `Thinking…` must never be pinned above already-drawn tool cards.
3. The next thinking segment (usually the next assistant message after tool results return) appears at the **new bottom**, below already-visible tools.
4. After settling, the vertical order matches this timeline: `Thought for` → that segment's tools → next `Thought for` line → next tool batch → body text. Titles are inserted into content order by activity-block anchors; dumping the whole bundle at the message tail is forbidden.
5. live noise / live signal, adjacent welding, `hideThinking` only hiding non-slot-owning thinking text, `thinkingMs` still the per-message first burst — all inherited from the Live-signal revision; this slice does not change the persistence algorithm.
6. Ctrl+O, thinking peek line-count product change, harness tool shapes, web, non-TUI CLI: not in this slice.

| Superseded behavior                                          | Current location                                               | After supersession                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| "live thinking pinned above the actions it drives" as a nailed headline | `src/tui/activity-block.ts` `appendLiveBlocks` (thinking block pushed first) | live thinking drawn at the transcript bottom; once tools appear the segment turns in place into `Thought for`, with cards below it |
| settled titles dumped at the message tail (or all blocks of one message sharing one anchor) | `src/tui/turn-fold-lines.ts` grouped by messageIndex           | titles inserted into content order by activity-block anchors (`contentBlockIndex`)     |

**Not authorized** (this section's exclusions): Ctrl+O expansion, thinking peek line counts, changing `thinkingMs` persistence, changing the keep / accent / failure classification table, changing the non-TUI CLI surface, changing web.

## Tech Stack

| Item           | Value                                                | Notes                                       |
| -------------- | ---------------------------------------------------- | ------------------------------------------- |
| Language       | TypeScript (consistent with harness, 5.x ESM)        | —                                           |
| Rendering      | `@opentui/react` 0.5.1                               | existing; this slice adds no rendering dependency |
| Testing        | vitest (pure derivation) + `$HOME/.bun/bin/bun test tests/tui/` | existing dual run (`npm test`)    |
| New dependencies | none                                               | pure derivation + converged consumption, no third-party imports |

## Commands

```bash
npm test                                    # full vitest suite + bun test tests/tui/
npm run typecheck                           # tsc --noEmit
npm run lint:s5                             # complexity hard gate (changed set)
npm run dev:tui                             # real TUI (MCP pty acceptance surface)
```

## Project Structure

| Path                                         | Form          | Notes                                                        |
| -------------------------------------------- | ------------- | ------------------------------------------------------------ |
| `src/tui/<activity-block derivation>.ts`     | **new**       | pure derivation: `messages + live runs → block list` (no React, no IO) |
| `src/tui/turn-fold-lines.ts`                 | change        | block-title construction converges to the new contract (`Thought for` / `calling` / `called`) |
| `src/tui/live-activity-group.ts`             | change        | retire the present-tense summary line; or thin it to slot-preview sourcing |
| `src/tui/turn-activity.ts`                   | change        | live tool aggregation feeds the block list instead           |
| `src/tui/chat-view.tsx`                      | change        | consumes the block list; the mutual-exclusion gate follows the slot owner |
| `src/tui/message-blocks.tsx`                 | change        | line assembly aligns with the block's two states             |
| `src/tui/think-fold.ts` / `thinking-gate.ts` | change/keep   | thinking-fold decision retained; `hideThinking` semantics rewired to the slot owner |
| `src/tui/tool-settled.ts`                    | unchanged     | keep / accent / retract classification table unchanged in this slice |
| `tests/tui/*`                                | change/new    | old dual-summarizer tests re-pinned to the new contract; new derivation fixture cases |

## Testing Strategy

| Level | Scope                                                                                                                                        | Tool                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Unit  | pure derivation block list: weld / cut / new message new block / `calling` vs `called` / failure items excluded from block counts / keep / accent outside blocks | vitest |
| Unit  | slot handoff: thinking stream → thinking text, quiet tools take over → dim preview, all finished → preview retracted                          | vitest                                   |
| Unit  | mutual-exclusion gate: the same retract batch never shows a present-tense line and an end-state line at once; a frozen stub never closes the next block's thinking slot | vitest |
| Unit  | boundaries: no thinking no tools / body directly after thinking without tools / quiet tools directly after thinking (no body) / body between thinking and quiet tools | vitest |
| Unit  | position contract: thinking-only live `Thinking…` at the bottom / segment end turns in place into `Thought for` with tools below it / second thinking segment below already-visible tools / settled titles inserted by anchor, never at message tail | vitest |
| TUI   | real session: on-screen sequence of thinking → quiet tools → body → quiet tools                                                              | `mcp__aiterm__pty_*` + `npm run dev:tui` |

**`npm test` = the only gate**: delivery bar = `npm test` exit 0 + `npm run typecheck` exit 0 + `npm run lint:s5` exit 0.

## Boundaries

### Always

- Activity blocks are a derivation of the TUI display surface: do not change harness tool shapes, the session transcript, `thinkingMs` persistence, or web.
- `docs/CONTEXT.md` is only written via `domain-modeling` (guarded by the `pre-context-write-guard` hook); this spec references entries, never redefines them.
- Failure items (failure overlay) cut across: never enter activity-block counts, never take the dim preview slot.
- `thinkingMs` stays per-message; block duration = that message's `thinkingMs`, never summed across messages.

### Ask first

- Deleting the `live-activity-group.ts` file itself (vs thinning it in place) — ask first if the blast radius exceeds the display surface.
- **Archiving** old tests (vs re-pinning them to the new contract) — apply test.md's "assess what the test certifies first" criterion; archive only when "the invariant has permanently disappeared".

### Never

- No Ctrl+O expansion (this slice).
- Do not change the keep / accent / failure classification table.
- Do not swallow failures into `called` (silent degradation).
- Do not add a second summarizer (a third tense is forbidden).

## Success Criteria

| #   | Criterion                                | Check                                                                                     |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| S1  | Block list unit-testable as pure derivation | a derivation module with no React import exports the block-list function; vitest calls it directly |
| S2  | Weld holds (thinking + adjacent quiet tools) | fixture: quiet tools directly after thinking → title contains `Thought for` + `calling`   |
| S3  | Cut holds (body in between)              | fixture: thinking → body → quiet tools → `Thought for` / body / `called name × N` as three separate segments |
| S4  | `calling` → `called` transition          | fixture: quiet tools running → title `calling`; all finished → `called` and preview retracted |
| S5  | New message opens new block              | fixture: two assistant messages → two blocks; the second never changes the first's counts |
| S6  | Failure items excluded from block counts | fixture: failed quiet tool → block counts exclude it; still goes to the failure overlay   |
| S7  | keep / accent remain solid cards outside blocks | fixture: keep tool → not welded into the block title; accent likewise                     |
| S8  | No stacked dual summarizers              | fixture: one retract batch never yields both a "present-tense line" and an "end-state line" |
| S9  | Slot handoff: thinking yields            | fixture: `text_delta` / `tool_call_start` during the thinking stream → thinking text leaves the slot, duration stays in the title |
| S10 | Four boundary classes covered            | fixture: no thinking no tools / thinking then body directly / thinking then quiet tools directly / body between thinking and quiet tools |
| S11 | `hideThinking` follows only the slot owner | fixture: a frozen stub never affects the next block's thinking-slot open/close            |
| S12 | Main path all green                      | `npm test` exit 0; `npm run typecheck` exit 0; `npm run lint:s5` exit 0                   |
| S13 | Real TUI measured                        | MCP pty starts `npm run dev:tui`, inject a prompt, read the screen to verify the activity-block sequence |
| S14 | live thinking at the bottom              | fixture: thinking-only in flight → `Thinking…` is the tail's last block, with no already-drawn tool card after it |
| S15 | Settled turns into `Thought for` in place | fixture: the segment's `tool_call_start` → the same anchor becomes `Thought for Ns`, tool cards below it |
| S16 | Second thinking at the new bottom        | fixture: first assistant's tool cards already visible → the second message's live thinking ordered after those cards |
| S17 | Titles inserted by anchor                | fixture: one message thinking → `web_search` → body → screen order `Thought for` → search card → body, no tail fold line |

## Open Questions

Not answered this cycle (out of scope, declared rather than silent):

- **Ctrl+O expansion of activity blocks**: not in this slice; trigger timing = once block tenses stabilize (next ticket).
- **The fate of `live-activity-group.ts`**: file deletion vs thinning to slot-preview sourcing, decided at implementation by the dependency surface (see Boundaries Ask first).
- **Visual spacing / fold glyph between blocks**: design detail; this slice only pins the tense and text contracts.

## Glossary

> From `docs/CONTEXT.md` (referenced by the spec, never redefined).

- **activity block**: TUI process chrome aligned to one assistant message — one title line plus one **body slot**, with live and settled states. Blocks append per message; never collapse a whole turn into one line.
- **body slot**: the block's only slot for body content. Thinking owns it while still in flight; after quiet tools take over it holds a one-line dim `⎿` current preview. The two never own it simultaneously.
- **adjacent weld**: only when nothing sits between thinking and quiet tools — no body, keep, accent, failure — may the title be written as `Thought for …, calling/called …`.
- **retract class (quiet tools)**: the tool class that takes no footprint card (reads / searches / queries). Live only enters the block's body slot; settled only enters that block's `called` counts.
- **keep class / accent class / failure overlay**: respectively the work class that keeps a title when settled, the named colorization class, and the cross-cutting failure (none changed in this slice).
- **thinking duration**: the persisted attribute `thinkingMs` of an assistant message (measured on the adapter streaming path); block duration = that message's `thinkingMs`, not summed across messages.
- **unit fold / live activity group / open unit / live tool line**: entries rewritten by this slice (see their current definitions in `docs/CONTEXT.md`).

## Architectural Constraints

| ADR / rule                                      | Citation form                                          |
| ----------------------------------------------- | ------------------------------------------------------ |
| `.claude/rules/code-quality.md` (SSOT)          | block list as the single source of truth; ChatView consumes only, never recomputes |
| `.claude/rules/test.md` (TUI real-ground acceptance) | changes reaching a session must run `npm test` + MCP pty real TUI screen reads |
| S5 complexity hard gate (cyc ≤ 10 / nest ≤ 4)   | pure-functional derivation module, failure classification never inflates; `lint:s5` exit 0 |

## ACR Verdict (architecture-change-reviewer · 5-verdict gate)

> From the interview plan (which already contains the ACR section; transcribed here as recorded).

```text
bounded-context-guardian: yes — chrome stays only in the tui display surface; harness tool shapes unchanged, session transcript / thinkingMs persistence unchanged, web unchanged.
input-contract-tests: yes — no thinking no tools; body directly after thinking with no tools; quiet tools directly after thinking (no body); body between thinking and quiet tools; failed quiet tools go to the failure overlay and not into the stub; the next assistant opens a new block (concurrent live and frozen stub coexist).
error-handling-enforcer: yes — the failure overlay cuts across and never enters activity-block counts; when derivation refuses to draw a block, `// EXIT:`; failures are never swallowed into `called`.
complexity-anti-drift: yes — one block, two states, produced by the pure derivation module; ChatView only consumes; a third stacked summarizer is forbidden; Listing/Reading/Searching must not remain in parallel with Thought for.
minimal-change-verifier: yes — one task = activity-block tenses; no Ctrl+O changes, no changes to the non-TUI CLI surface, no changes to TOOL_SETTLED_CLASS's keep/accent lists (quiet = current retract).
```

**Gate result: 5/5 yes, hand to implementation.**

- affects: docs/CONTEXT.md
- affects: specs/tui-activity-block.md (new)
- affects: src/tui/<activity-block derivation>.ts (new)
- affects: src/tui/turn-fold-lines.ts
- affects: src/tui/live-activity-group.ts
- affects: src/tui/turn-activity.ts
- affects: src/tui/chat-view.tsx
- affects: src/tui/message-blocks.tsx
- affects: tests/tui/*
