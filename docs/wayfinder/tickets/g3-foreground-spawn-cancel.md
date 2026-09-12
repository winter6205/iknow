# G3 前景 spawn 墙钟与操作员取消

- Map: [主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）](../agent-control-surface-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-11，操作员裁 A + 子代理可见/强杀)
- Blocked by: R2（已结）

## Question

默认 `wait:true` + `timeoutTier: unbounded` + 模型可自填 `timeoutMs`（本会话 600000）时，操作员要哪条取消契约：

- A：Ctrl+C 必须取消 wait，`/quit` 先 abort 再等（改 TUI，不改默认 wait）。
- B：长任务默认改 `wait:false` + mailbox 唤醒（挑战 ADR-0014 默认前景）。
- C：给 `timeoutMs` 加操作员可见帽 / 拒绝过大自填，超时 envelope 不得标 `tool_kind=ok`。

本票等 R2 的调用链，不写代码。

## Resolution

操作员裁 **A**：`/quit` 先 abort 再等收尾；前台 Ctrl+C 必须能取消 wait（有选区可先复制，需可感知，再按或 Esc 取消 turn）。超时不得标 `tool_kind=ok`。默认仍 `wait:true`。

加 TUI 确认「子代理是否在跑」与强杀（风格沿用现有 `● ○` / `> ` 聚焦，不做 Enter 进详情、不加第二套 picker 文案）：

- **会话消息内**：活子代理显示 `{role} running...`，下一行 dim 为最新内容（taskPreview / 最近工具）。
- **输入框下概览**：既有子代理行；Down 从输入框进入该列（chrome-focus 已有），聚焦行 `> `；**Ctrl+X** 强杀该行，父 turn 收到 cancelled / 打断回执。无 Enter-to-view。
