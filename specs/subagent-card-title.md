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

The `spawn_subagent` card in the session transcript shows a stable short title on line 1 and a single activity slot on line 2. The parent writes the title when it dispatches. While the worker runs, line 2 is the name of the tool that worker is executing, drawn dim. When that worker completes, the same slot becomes a green `✓ Done`. The task body stays with the worker and on the bottom panel; it is not the card title.

**User**: the operator watching the TUI session transcript (`npm run dev:tui`).

## Boundaries

- **Does:**
  - Add a required `title` string on `spawn_subagent`. After trim, empty or whitespace-only is a `ToolExecutionError` and no worker starts. Longer than 80 characters (JavaScript string length after trim) is the same error. The accepted title is filed on that worker's spawn record and reaches the card through the read-only subagent list; the worker prompt never carries it.
  - Line 1 of a `spawn_subagent` card is that title, clipped to the card width with the existing one-line visual clip. Live and completed render the same title. No `running...` suffix.
  - Line 2 is one slot. Joined and live (`starting` or `running`): dim text is the in-flight tool name, or an empty placeholder when that worker has no tool call waiting on a result. Joined and `completed`: the slot is the literal green `✓ Done` (`fg = tuiPalette.add`); the tool name is not kept. The card is exactly these two lines.
  - The in-flight name is the latest `tool_use` on that worker's transcript that has no matching `tool_result` yet. The card host does not parse the transcript. The existing read-only subagent list gains that name and the card reads it at the list's existing refresh. Worker stdout stays one terminal envelope.
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

## Success Criteria

- **SC1**: `spawn_subagent` with `title` missing, `""`, whitespace-only, or longer than 80 after trim returns `ToolExecutionError` and starts no worker. `npm test` covers these four inputs.
- **SC2**: A joined live card renders line 1 as the accepted `title` and line 2 dim as the in-flight tool name. With no in-flight tool, line 2 is an empty placeholder and the card is still two lines. No `running...`, no `taskPreview`, on either line.
- **SC3**: When that joined worker is `completed`, line 1 is unchanged and line 2 is green `✓ Done`. The last tool name is absent.
- **SC4**: Two concurrent workers: each card shows its own title and its own in-flight tool name.
- **SC5**: A joined `failed` worker does not take `✓ Done`; the failure overlay remains.
- **SC6**: Worker stdout for a spawn is still a single terminal envelope. The activity name is not a field on the parent-visible handoff envelope.
- **SC7**: `SubagentPanel` tests stay green. `subagent_result` cards are unchanged.
- **SC8**: The `title` property description on `spawn_subagent` states that it is a short title for the operator, a few words, and that `task` is the assignment the worker receives. Locked by the existing STATIC description guards (`tests/subagent/spawn-subagent.test.ts`, `tests/harness/aci/tools/d9-description-guard.test.ts`). No new trajectory set: the hard gate is the schema, and the dispatch-lesson row in `docs/guides/prompt-development.md` already registers that surface as not built.

Session-facing check for SC2–SC3, per `.claude/rules/test.md`: `npm test` plus one `mcp__aiterm__pty_*` TUI run that shows the two lines on the spawn card. `npm run test:real-llm` and `probe:*` are not required: this slice does not change the model loop, the fence, or worker bootstrap.

## Open Questions

(none)

## Inherits / Changes

Quoted current term (`docs/CONTEXT.md`):

> **subagent card live（子代理会话卡实时行）**: `spawn_subagent` 画在会话那张卡上：live 为角色行加一行 dim 任务概述（`taskPreview`）；**completed** 后概述留下，其下绿 `✓ Done`，不再写 `running...`。位置在该消息下，不在输入框上方。failed 走该卡 **failure overlay**。角色行 = catalog id（`subagent_type` / `SubagentInfo.role`，缺省 `general-purpose`）；task 正文里的 `ROLE: implementation worker` 不是角色。同一 worker 不得再并排一张未 join 的 `general-purpose running`。

- **Inherits**: card position under the spawn message; failure overlay for `failed`; catalog role as the fallback identity (`SUBAGENT_ROLE_FALLBACK`); `clipOneLineVisual`; `tuiPalette.dim` / `tuiPalette.add`; join by `toolUseId`; `ToolExecutionError` for spawn input rejection; **工人 transcript** (ADR-0102) as the append-only record of the worker's `tool_use` / `tool_result`; worker stdout = one envelope (`src/harness/subagent/worker.ts`).
- **Changes**: this spec replaces the card's role line, dim `taskPreview` line, and extra `✓ Done` line. Line 1 is `title`. Line 2 is the activity slot described above. `specs/tui-subagent-transcript-live.md` locked sentences 1–2 and its card table are superseded for line content only; position, panel, and `subagent_result` exclusions in that spec still hold.
- **Unchanged**: `taskPreview` on `SubagentInfo` and on the bottom panel; role on `SubagentInfo` for the panel and for the no-title fallback.

### 待写入

Flushed: **subagent card live** in `docs/CONTEXT.md` now matches this contract. No new term. No ADR.

## Input-contract classes

| Surface                  | empty                                                                                                                | invalid / negative                                | overflow                                                 | concurrent                                                                          | exception                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `spawn_subagent` `title` | missing / `""` / whitespace → `ToolExecutionError`, no worker                                                        | non-string rejected by the existing schema        | length after trim > 80 → `ToolExecutionError`, no worker | two spawns in one turn each carry their own title                                   | handler does not start a worker before the title check                                       |
| card line 1              | spawn record has no `title` → catalog role; no live list (reopened session) → that block's own durable `input.title` | failed join → failure overlay, no title+Done pair | one-line visual clip; `cols ≤ 0` → 1-column budget       | each card reads its own spawn record                                                | title text is not parsed as a role or as `task`                                              |
| card line 2              | joined live, no in-flight tool → empty placeholder, row kept; no live list → blank slot, not `✓ Done`                | joined failed → slot not drawn                    | tool name clipped to one line                            | each card reads only its joined worker                                              | transcript has no `tool_use` → empty placeholder; invalid records do not throw into the card |
| activity projection      | worker transcript missing → empty name, card still draws the placeholder                                             | name is not ADR-0028 `lastTool`                   | N/A                                                      | two workers, two transcripts; read rate is the list's poll rate × live worker count | stdout unchanged: one envelope at the end; an unreadable ledger is named once on stderr      |
