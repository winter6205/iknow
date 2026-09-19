# R2 本仓三条列表面现在显示什么

- Map: [会话列表显示的会话概要（决策）](../session-list-label-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved
- Blocked by: —

## Question

iknow 会话列表（TUI、Web、HTTP list）现在用哪些字段当「概要」？`title` / `lastFinalText` / `goal` 各自怎么来、列表行实际渲染哪一个？有没有手改标题入口？

## Resolution

**磁盘 / API**

- `SessionFileV1.title`：首条带 text 的 user 消息，`trim` 后切 80 字（`extractTitle`）。#467 从 `summary` 改名，注释写明这是 **UI title excerpt，不是 LLM summary**。
- compact 后仍用 compact **前**的 messages 抽 `title`，避免变成 preamble / `[compaction boundary…]`。
- `SessionListEntry.lastFinalText`：最近一条助手文本；无则 `""`。list 派生，不是独立生成。
- `goal`：会话级目标（`/goal` / `## GOAL:`），**不是**列表行文案。
- HTTP `GET /sessions` 条目同时带 `title` 与 `lastFinalText`。

**TUI `/sessions`**（`src/tui/list-view.tsx`）

- 行主文案 = `entry.title`，空则 `(空)`，再加相对时间、可选 `[运行中]`。
- 搜索匹配 `title` **或** `lastFinalText`，但 **不展示** `lastFinalText`。

**Web 侧栏**（`grouped-view.tsx` `SessionItem`）

- 行主文案 = `lastFinalText` 截 32 字；空则 `conversation_id` 前 8 位。
- **不读 `session.title`**。tooltip 是完整 id。

**手改**

- 仓库内无 session rename / `PATCH title` / `/title`。`title` 随消息重算覆盖；没有「用户钉死」的 source。

因此操作员说的「会话概要」在本仓已分裂：TUI 看首问截断，Web 看末次助手截断，名字还都叫列表，字段却不是同一个。
