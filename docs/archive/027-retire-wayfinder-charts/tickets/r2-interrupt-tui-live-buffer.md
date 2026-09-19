# R2 TUI 是否另清 live 缓冲

- Map: [打断后本轮去哪了](../interrupt-round-visibility-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved (charting research, 2026-09-19)
- Blocked by: —

## Resolution

墙是**双层**：历史 = `session.messages`；live overlay = `streamDraft` / draft·thinking、`liveToolRuns`·`liveToolLines`（`chat-view.tsx:242-247`；`app.tsx:4093-4108`）。`Interrupted by user.` 只从 store 的 system 消息画（`message-blocks.tsx:368-371`）。

Esc **当下**只 `abort()`（`app.tsx:2988-2996`），不清墙。清 overlay 发生在 `runTurnOnce` **settle**：`finally` 里 `draft.reset()` / `setStreamDraft(null)`（2773–2774），随后 `loadSessionFile` + `turnFinished` 用**文件快照**换 `messages` 并 `runState:"idle"`，再 `setLiveToolRuns([])`（2801–2826）。

因此「墙上曾有流式 → 回落到 store 快照」是主路径。store 若无对应 assistant，流过的字不会留在墙上。Esc 瞬间不会把已 echo 的 user 立刻抹掉；整轮是否「空」取决于 settle 后文件里还有什么（R1）。

## Question

TUI 聊天墙在 Esc **前台打断** 当下，是否有一套**独立于** session store 的 live 缓冲（流式 delta、activity block、当前 turn 的 React state），abort 时被清掉，即使 store 里还留着 user 或 interrupt 文案？

需要 `file:line`：

- chat 墙的数据源（props / store 快照 / 流式 overlay）
- abort / `cancelled` / `running-fg` → idle 时，哪些 state 被 reset
- 是否存在「store 有本轮、墙上没有」或「墙上曾有、reset 后只剩 store 快照」的路径

本票不裁定产品契约，不把 closeout 政策当渲染结论（那是 R1）。
