# G2 列表行主文案用 title 还是 lastFinalText

- Map: [会话列表显示的会话概要（决策）](../session-list-label-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: closed（2026-09-19，与 G1/G3 同回合 coupled）
- Blocked by: R2

## Question

三条列表面（TUI、Web、HTTP 消费者）**一行里给人扫的那几个字**，主字段该对齐成哪一个？

- 只用 `title`（意图 / 开场）
- 只用 `lastFinalText`（近况 / 最后一句助手）
- 主 `title`、副 `lastFinalText`（双行或主副）
- 维持现状：TUI 用 title、Web 用 lastFinalText

「扫一眼找回上周那次」时，开场意图和最后进度哪个更不可丢？TUI 行高预算是否允许副行？

## Resolution

主文案三条面对齐 **`title`（开场意图）**。`lastFinalText` 只做 list 派生：搜索可继续命中，**不进行主文案**。不做双行（TUI 一行预算；Web 侧栏改接到 `title`）。不维持 TUI/Web 分裂。
