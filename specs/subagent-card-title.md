# Spec: subagent card title and activity slot

**Status:** ACR all-yes (see below). Glossary **subagent card live** flushed to this contract.

## Architecture-change-reviewer

```
bounded-context-guardian: yes — the title check stays in spawn-subagent-tool, the in-flight name rides the existing read-only subagent list, and the card host does not parse the worker transcript (stdout remains one envelope).
input-contract-tests: yes — the input-contract table covers empty, invalid, overflow, concurrent, and exception for title, both card lines, and the activity projection, with SC1 naming the four title rejects.
error-handling-enforcer: yes — a bad title throws ToolExecutionError and starts no worker; a missing transcript, invalid records, and a failed join exit as an empty placeholder, a non-throw, and the failure overlay. An unreadable or undecodable ledger also names itself once on stderr, so a wiring fault is not indistinguishable from "nothing in flight".
complexity-anti-drift: yes — validation, list name, and the two-line card stay separate layers, the card does not also scan the transcript, and taskPreview stays on SubagentInfo and SubagentPanel only.
minimal-change-verifier: yes — one card-title contract; panel, web bar, lastTool, token stream, status file, and worker prompt are out of scope, with only a glossary amend and no ADR.
```

## Objective

The `spawn_subagent` card in the session transcript shows a stable short title on line 1 and a single activity slot on line 2. The parent writes the title when it dispatches. Line 2 is that worker's most recently issued tool call — the tool name plus the argument summary of that call's recorded input — drawn dim, and it stays through that call's `tool_result` until a later `tool_use` replaces it; the slot therefore never says the call is still running or that it succeeded. When that worker completes, the same slot becomes a green `✓ Done`. The task body stays with the worker and on the bottom panel; it is not the card title.

**User**: the operator watching the TUI session transcript (`npm run dev:tui`).

## Boundaries

- **Does:**
  - Add a required `title` string on `spawn_subagent`. After trim, empty or whitespace-only is a `ToolExecutionError` and no worker starts. Longer than 80 characters (JavaScript string length after trim) is the same error. The accepted title is filed on that worker's spawn record and reaches the card through the read-only subagent list; the worker prompt never carries it.
  - Line 1 of a `spawn_subagent` card is that title, clipped to the card width with the existing one-line visual clip. Live and completed render the same title. No `running...` suffix.
  - Line 2 is one slot. Joined and live (`starting` or `running`): dim text is that worker's most recently issued tool call as `tool name · argument summary`, or an empty placeholder when no call has been read for it. Joined and `completed`: the slot is the literal green `✓ Done` (`fg = tuiPalette.add`); the retained call is dropped. The card is exactly these two lines.
  - The slot is the latest `tool_use` in that worker's own ledger and keeps that call after its `tool_result`, until another `tool_use` replaces it. With multiple calls the slot represents the latest call in ledger order only; it does not imply that the call is still running or succeeded. The text is the shared tool-summary formatter's own output for that call's recorded input (`src/shared/tool-line.ts`: `TOOL_SUMMARIES` / `summarizeToolCall` / `formatToolStatusLine` with status `ok`), clipped to one visual line at the card width. A tool the table does not know shows the bare tool name; an input that is legacy or not an object is read as empty and falls back to that tool's own missing-field wording (e.g. `read_file · Read ?`). Neither ever exposes raw JSON, and an empty summary shows the bare name with no dangling ` ·`. the two `subagent` tools keep their own detail-only shape. Past-tense summaries such as `Wrote <path>` name the requested operation, not an outcome. The card host does not parse the transcript. The existing read-only subagent list gains that call — name and recorded input — and the card reads it at the list's existing refresh. Worker stdout stays one terminal envelope.
  - A spawn record with no `title` (a direct manager spawn that never went through the tool) uses the catalog role for line 1 (`subagent_type`, else `general-purpose`). It does not borrow another worker's title or tool name.
  - A settled `spawn_subagent` block that no live worker describes — a session reopened without the previous process's list — reads line 1 from that block's own durable `tool_use.input.title`, and falls back to the catalog rule when the input carries none. Line 2 stays the empty placeholder there: `✓ Done` asserts a completion the reloaded card has no worker left to confirm.
  - `failed` stays on that card's failure overlay. No green `✓ Done`.
- **Confirms with human:** (none — the discussion settled the title field, the two-line card, and the activity slot)
- **Out of this spec:**
  - `SubagentPanel` (bottom rows, focus expand of `taskPreview`, Ctrl+X order)
  - Web status bar, activity-block live-signal, `subagent_result`
  - A group header that counts parallel spawns
  - ADR-0028 `lastTool` (last successful tool, model status bar, not this card)
  - A token stream, a second stdout protocol, or a new status file
  - Putting `title` into the worker prompt
  - A `description` field on the worker's tool calls (required or optional), a tool schema change, or a prompt instruction backing the activity summary

## Success Criteria

- **SC1**: `spawn_subagent` with `title` missing, `""`, whitespace-only, or longer than 80 after trim returns `ToolExecutionError` and starts no worker. `npm test` covers these four inputs.
- **SC2**: A joined live card renders line 1 as the accepted `title` and line 2 dim as that worker's most recently issued call, `tool name · argument summary`, and keeps that call after its `tool_result` until a later `tool_use` replaces it. With no call read for that worker, line 2 is an empty placeholder and the card is still two lines. The slot is not evidence that the call is running or succeeded. No `running...`, no `taskPreview`, on either line.
- **SC3**: When that joined worker is `completed`, line 1 is unchanged and line 2 is green `✓ Done`. The retained call is absent.
- **SC4**: Two concurrent workers: each card shows its own title and its own retained call — the latest `tool_use` in that worker's own ledger, name plus summary.
- **SC5**: A joined `failed` worker does not take `✓ Done`; the failure overlay remains.
- **SC6**: Worker stdout for a spawn is still a single terminal envelope. The activity (tool name and argument summary) is not a field on the parent-visible handoff envelope.
- **SC7**: `SubagentPanel` tests stay green. `subagent_result` cards are unchanged.
- **SC8**: The `title` property description on `spawn_subagent` states that it is a short title for the operator, a few words, and that `task` is the assignment the worker receives. Locked by the existing STATIC description guards (`tests/subagent/spawn-subagent.test.ts`, `tests/harness/aci/tools/d9-description-guard.test.ts`). No new trajectory set: the hard gate is the schema, and the dispatch-lesson row in `docs/guides/prompt-development.md` already registers that surface as not built.

Session-facing check for SC2–SC3, per `.claude/rules/test.md`: `npm test` plus one `mcp__aiterm__pty_*` TUI run that shows the two lines on the spawn card. `npm run test:real-llm` and `probe:*` are not required: this slice does not change the model loop, the fence, or worker bootstrap.

## Open Questions

(none)

## Inherits / Changes

Quoted current term (`docs/CONTEXT.md`):

> **subagent card live（子代理会话卡实时行）**: `spawn_subagent` 画在会话那张卡上：live 为角色行加一行 dim 任务概述（`taskPreview`）；**completed** 后概述留下，其下绿 `✓ Done`，不再写 `running...`。位置在该消息下，不在输入框上方。failed 走该卡 **failure overlay**。角色行 = catalog id（`subagent_type` / `SubagentInfo.role`，缺省 `general-purpose`）；task 正文里的 `ROLE: implementation worker` 不是角色。同一 worker 不得再并排一张未 join 的 `general-purpose running`。

- **Inherits**: card position under the spawn message; failure overlay for `failed`; catalog role as the fallback identity (`SUBAGENT_ROLE_FALLBACK`); `clipOneLineVisual`; `tuiPalette.dim` / `tuiPalette.add`; join by `toolUseId`; `ToolExecutionError` for spawn input rejection; **工人 transcript** (ADR-0102) as the append-only record of the worker's `tool_use` / `tool_result`; worker stdout = one envelope (`src/harness/subagent/worker.ts`).
- **Changes**: this spec replaces the card's role line, dim `taskPreview` line, and extra `✓ Done` line. Line 1 is `title`. Line 2 is the activity slot described above. The issue #1233 amendment further replaces this spec's in-flight pairing rule (the latest `tool_use` with no matching `tool_result`) with the retained-call rule and adds that call's argument summary; the two-line budget, `✓ Done`, failure overlay, reopened-settled-card, and empty-slot clauses above are unchanged. `specs/tui-subagent-transcript-live.md` locked sentences 1–2 and its card table are superseded for line content only; position, panel, and `subagent_result` exclusions in that spec still hold.
- **Unchanged**: `taskPreview` on `SubagentInfo` and on the bottom panel; role on `SubagentInfo` for the panel and for the no-title fallback.

### 待写入

Flushed: **subagent card live** in `docs/CONTEXT.md` now matches this contract, including the retained call and its argument summary. No new term. No ADR.

## Input-contract classes

| Surface                  | empty                                                                                                                | invalid / negative                                | overflow                                                 | concurrent                                                                          | exception                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `spawn_subagent` `title` | missing / `""` / whitespace → `ToolExecutionError`, no worker                                                        | non-string rejected by the existing schema        | length after trim > 80 → `ToolExecutionError`, no worker | two spawns in one turn each carry their own title                                   | handler does not start a worker before the title check                                  |
| card line 1              | spawn record has no `title` → catalog role; no live list (reopened session) → that block's own durable `input.title` | failed join → failure overlay, no title+Done pair | one-line visual clip; `cols ≤ 0` → 1-column budget       | each card reads its own spawn record                                                | title text is not parsed as a role or as `task`                                         |
| card line 2              | joined live, no call read → empty placeholder, row kept; no live list → blank slot, not `✓ Done`                     | joined failed → no slot; unknown tool → bare name | name + argument summary clipped to one line at width     | each card reads only its joined worker; latest call in that ledger                  | no `tool_use` → empty slot; invalid records do not throw into the card; never raw JSON  |
| activity projection      | worker transcript missing → empty value, card still draws the placeholder                                            | call is not ADR-0028 `lastTool`                   | N/A                                                      | two workers, two transcripts; read rate is the list's poll rate × live worker count | stdout unchanged: one envelope at the end; an unreadable ledger is named once on stderr |
