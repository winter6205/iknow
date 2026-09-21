# Spec: tui-subagent-transcript-live — live sub-agent's two lines land on the session spawn card

**Status:** ready for plan
**Surface:** `src/tui/subagent-message-lines.ts`, `src/tui/live-tool-preview.tsx`, `src/tui/message-blocks.tsx`, `src/tui/app.tsx`, `src/harness/subagent/manager.ts` (read-only projection)

> Input = `plans/tui-subagent-transcript-live.md` (ACR 5/5 yes; nine locked sentences; the `docs/CONTEXT.md` entry `subagent card live` already flushed).
> Supersedes = Slice D / SC14, which made the two lines chrome above the prompt (`SubagentIdentityStrip`) — this spec re-awards the position to **the `spawn_subagent` card inside the session transcript**.
> **Reopen (`plans/strategy-window-and-subagent-card.md` T1)**: locked sentence 2 / the completed-state table / SC2 — after completion the summary stays and gains `✓ Done`; line 2 is no longer replaced by a literal `done`, and `running...` is no longer kept either.
> Scope = position move + completed state + read-only `toolUseId` join; SubagentPanel, harness spawn/abort, web, Ctrl+X, and activity-block live-signal are untouched.
> Landing = T1 this spec → T2 projection (incl. `listSubagents` read-only `toolUseId`) → T3 card carries the two lines, strip removal → code-review → verification-before-completion.

## Goal

A live sub-agent is no longer drawn directly above the input box; it is drawn under **the `spawn_subagent` card in the session that dispatched it**: live line 1 `{role} running...`, line 2 dim = that worker's task summary (`taskPreview`); after completion the summary stays, with a green `✓ Done` beneath it, and `running...` is never written again. The identity strip above the input box is removed, and its chrome row budget drops to zero.

**User**: iknow is a single-user, single-project local product; the TUI is the main acceptance surface (`npm run dev:tui`).

**What to build**:

1. **Card-level two-line projection** (pure function): `subagents × toolUseId → {roleLine, detailLine, done}`; join misses → do not draw line 2.
2. **Join key**: `SubagentInfo.toolUseId` (= the tool_use id of the dispatching `spawn_subagent` call) exposed read-only via `listSubagents`; same id space as the card-side `tool_use.id` / `LiveToolRun.id`.
3. **Two hosts**: the live tail (`liveToolPreviewBox`, while spawn blocks the foreground) and historical cards (`MessageBlocks`, after the turn ends) share the same projection.
4. **Removal**: `SubagentIdentityStrip` and its prompt-side row budget (`subagentRowBudget` → the `chromeReserveRows.subagentRows` product path is no longer fed).

## Locked sentences

Nine locked sentences (inherited from `plans/tui-subagent-transcript-live.md`; implementation and review both defer to them):

1. Each live `spawn_subagent` occupies two lines on **that card in the session transcript**: line 1 `{role} running...` (three dots), line 2 dim = that worker's task summary (`taskPreview`).
2. Once the worker is **completed**, the task summary stays, with a green `✓ Done` beneath it; the summary must not be replaced by a literal `done`; `running...` must not appear again. Nothing moves next to the input box, and nothing disappears with the bottom panel's fade-out.
3. The identity strip directly **above** the input box (`SubagentIdentityStrip`) is removed; its chrome row budget goes to zero.
4. `SubagentPanel` **below** the input box (`●` / durations / completion fade / Ctrl+X row order) is unchanged by this ticket.
5. **failed** never takes the green `✓ Done`: keep that tool card's existing **failure overlay**.
6. The live stream only attaches to the spawn card whose `toolUseId` matches; if the projection lacks `toolUseId`, draw line 1 only and never borrow another worker's preview (`// EXIT:`).
7. `subagent_result` stays a polling card; the two lines do not apply.
8. No longer strip the spawn title into a fragment without `running...` just to "avoid dual render"; identity defers to the session card, and the bottom panel remains the task list.
9. Web status bar, harness spawn/abort, activity-block live-signal: not in this slice.

### Implementation reading of the locked sentences (anti review-drift)

- Locked sentence 1's "task summary" **is exactly** `SubagentInfo.taskPreview` (already truncated ≤120 by the manager), refreshed by 1Hz read-only polling — **not** a per-token stream; this slice adds no streaming channel.
- Locked sentence 2: after completion the summary stays; beneath it a green `✓ Done` (including ✓). Line 1 must not carry `running...` anymore. If a role title remains, it is identity only, never running.
- Locked sentence 6's "missing `toolUseId`" = **the sub-agent-side projection lacks the association key** (defs without one / non-spawn sources). The card still draws line 1 (role derived from the card's own input's `subagent_type` → `role` → catalog fallback); it does **not** substitute any other worker's `taskPreview`.
- Relation of locked sentences 5 and 6: failed workers do not enter the join map; the card falls back to the existing failure overlay (title + one short error line), with no completion check.
- **The completed state depends on the in-process projection**: `✓ Done` requires the worker to still be in the `subagents` list (in process). After an app restart there is no join source → that historical card falls back to the existing single-line settled summary; this slice introduces no on-disk association (no second persistence scheme).
- **`wait:false` cards**: spawn returns `{task_id}` immediately (the tool card has settled) while the worker is still running — the two lines still draw on the card (the join only asks the worker's state, not whether the tool card has settled). This is not a hole but the correct shape of this slice.
- **Un-joined live spawn cards** (no `toolUseId`: ask / direct handler call / test injection): line 1 still draws `{role} running...` (role derived from the card's own input's `subagent_type` → `role` → catalog fallback), no line 2 — never borrowing any other worker's preview. This shape and "joined but still live" both start on screen with `{role} running...`; the only difference is the dim stream line.

## Card contract (single shape for the implementation surface)

```ts
export interface SubagentCardLines {
  readonly roleLine: string; // live: `{role} running...`; completed: identity line, without `running...`
  readonly detailLine: string; // live and completed both: taskPreview (truncated by cols)
  readonly doneLine?: string; // completed → `✓ Done`; absent while live
  readonly done: boolean; // completed-state color: true → tuiPalette.add (green)
}
```

| Card state                                | Screen                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| live (`starting` / `running`, joined)     | line 1 `{role} running...`; line 2 dim summary                                                      |
| completed (joined)                        | summary stays; green `✓ Done` beneath; no `running...`                                              |
| failed (joined)                           | no completion check — the card's failure overlay takes over (locked sentence 5)                     |
| spawn card (running, not joined)          | line 1 only; wording = the existing dotless `{role} running` from `formatToolStatusLine` (template unchanged, locked sentence 6) |
| spawn card (ok, not joined)               | existing single-line title (the `{role}` settled summary), unchanged by this slice                  |
| non-spawn (incl. `subagent_result`)       | entirely unchanged by this slice (locked sentence 7)                                                |

The "line 1" wording source shared by the two hosts splits into two paths, and **neither may write its own template**:

- spawn cards (`spawn_subagent`) with a projection → go through `SubagentCardView` (live: `{role} running...` + summary; completed: summary + green `✓ Done`);
- any other tool card (incl. `subagent_result`) → fully the existing `formatToolStatusLine` path, bytes identical to before the change.

That is: the two-line shape hangs only on `spawn_subagent`; the other half of `isSubagentTool` (the polling card) keeps its existing detail-only shape.

Both hosts share the table above: the live tail (`liveToolPreviewBox` / `liveToolPreviewTextLines`) and historical cards (`MessageBlocks`) must go through the same projection function; no second template set.

## Superseded

| Superseded behavior                                                                        | Current location                                                     | After supersession |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------ |
| two lines drawn directly above the input box (`SubagentIdentityStrip`)                     | `src/tui/subagent-identity-strip.tsx`, mounted in `app.tsx`          | the two lines draw on the session spawn card; the component is deleted |
| strip line count charged into the chrome budget (per live × 2)                             | `app.tsx subagentRowBudget` → `chromeReserveRows.subagentRows`       | the product path no longer feeds it (default 0); the explicit `chromeReserveRows` argument is kept (unit tests / legacy call compatibility), same convention as `panelRows` |
| the two-line message projection spreads the whole live list                                | `subagent-message-lines.ts projectSubagentMessageLines`              | becomes a card-level projection (join by `toolUseId`, per card)   |
| the two-line budget regression pinning "the strip occupies 2 rows above the input"         | `tests/tui/subagent-two-line-budget.test.tsx`                        | re-pinned to "sub-agents take no prompt row budget; the two lines grow on the card" |
| SubagentPanel excluded from the chrome budget (`panelRows` always 0; "rows that don't fit overflow below the screen") | #1044 `app.tsx subagentPanelRowBudget` → `chromeReserveRows.panelRows` | the assumption fails: bottom chrome has no explicit height and defaults to `flexShrink=1`, so when total height overflows Yoga distributes the negative space to the input box proportionally (reproduces whenever live ≥7, independent of terminal height). Current: panel rows (collapse cap `SUBAGENT_PANEL_MAX_ROWS=5`, overflow folds the last row into `… +N`) are budgeted — the input box shifts up normally and is always fully displayed; focus ring / clamp switch to `visibleLiveRowCount` (visible live row count), so focus never lands on a hidden row after folding |

**Not authorized** (explicitly excluded from this slice): changing `SubagentPanel` and the Ctrl+X row order, harness spawn/abort/timeouts, web `SubagentStatusBar`, activity-block live-signal, applying the two lines to `subagent_result`, restoring the prompt-side identity strip, changing `formatToolStatusLine`'s existing text templates.

## Input-contract classes

| Surface                                                | empty                                                   | invalid / negative                                                  | overflow                                                                    | concurrent                                                    | exception |
| ------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- | --------- |
| `projectSubagentCardLines(subagents, toolUseId, cols)` | empty array / `toolUseId` absent or empty string → `null` (never borrow a stream) | no match / matched to failed → `null`; empty or whitespace-only role → catalog fallback | each of the two lines truncated to cols by visual width (CJK-safe), never wrapping; `cols ≤ 0` → 1-column budget | two live workers: each card takes only its own joined `taskPreview`, never crossed | never reads `startedAt` / `endedAt` (invalid ISO cannot affect the projection); missing `taskPreview` → line 2 is an empty placeholder, budget still 2 rows |
| `subagentCardLinesMap(subagents, cols)`                | empty array → empty map                                 | entries missing `toolUseId` or failed are skipped wholesale (not in the map) | same as left (per-entry truncation by cols)                                 | duplicate `toolUseId`: first in list order wins (deterministic) | same as above |
| `listSubagents`'s `toolUseId` field                    | def without `toolUseId` → the field is omitted entirely (Postel, byte-stable) | empty string → omitted                                              | N/A                                                                         | N/A                                                           | N/A |
| `liveToolPreviewTextLines(run, cols, card?)`           | no card and running → 1 line only                       | failed run → does not consume card (existing failure line path)     | line content truncated by cols                                              | N/A                                                           | N/A |
| `MessageBlocks` historical cards                       | no map → byte-identical to before the change            | map hit on failed → no two lines                                    | two lines truncated by innerCols                                            | N/A                                                           | missing `subagentCards` prop (legacy call) → same as before the change |

## Success criteria

- **SC1**: In a real session, while a foreground `spawn_subagent` runs, its card shows `{role} running...` + a one-line dim `taskPreview` in the transcript; no `{role} running...` line appears above the input box anymore.
- **SC2**: After that worker completes, the same card still shows the task summary with a green `✓ Done` beneath (`fg = tuiPalette.add`); `running...` must never reappear, and it must not degrade to a literal `done` alone.
- **SC3**: Two concurrent live workers each occupy their own card without preview crossing (card A never shows B's `taskPreview`).
- **SC4**: Sub-agent entries lacking `toolUseId`: the card draws line 1 only and never borrows another's preview (`// EXIT:` on the rejection branch).
- **SC5**: Product calls of `chromeReserveRows` no longer reserve rows above the prompt for sub-agents; whether live sub-agents exist does not change the chrome budget.
- **SC6**: `SubagentPanel` (bottom `●` rows / durations / completion fade / Ctrl+X row order) behaves exactly as before, with all existing panel tests green.
- **SC7**: `subagent_result` cards and failed spawn cards never take the two lines (existing failure overlay / polling-card tests stay green).

## Inherits / Changes

- **Inherits**: the `isLiveSubagent` predicate (`starting` + `running`, same source as panel / Ctrl+X dispatching), `resolveIdentityRole`'s catalog fallback (`SUBAGENT_ROLE_FALLBACK`, never emitting the legacy Chinese "sub-agent" literal as a role), the `clipOneLineVisual` truncation discipline, `tuiPalette`'s `dim` / `add` tokens, `SubagentInfo`'s Postel discipline (optional fields omitted when absent).
- **Changes**: `SubagentInfo` gains an optional read-only `toolUseId`; `subagent-message-lines.ts`'s projection moves from "spread the whole live list" to "card-level join by `toolUseId`"; `SubagentIdentityStrip` is deleted; `subagentRowBudget` keeps its signature and always returns 0 (see the Superseded table: making "no longer budgeted" an explicit declaration, while the explicit `chromeReserveRows` argument is kept for unit tests / legacy calls).
- **Unchanged**: the wording-template logic in `src/shared/tool-line.ts` (the sub-agent branch's detail-only shape remains the fallback when the join misses), `SubagentPanel`'s projection, the harness spawn/abort lifecycle.

## Evidence pointers

- Plan: `plans/tui-subagent-transcript-live.md` (position move); completed-state revision: `plans/strategy-window-and-subagent-card.md`.
- Predecessor: Slice D / SC14 (`specs/agent-control-surface.md`, archived) landed the two lines as chrome above the prompt.
- Domain term: the `docs/CONTEXT.md` entry **subagent card live** (flushed; this slice lands it).
- Join-key upstream: `SubAgentDefinition.toolUseId` (`src/harness/subagent/role.ts`) ← `ToolExecutionContext.toolUseId` (executor `call.id`) ← written into the def by `spawn-subagent-tool`.
