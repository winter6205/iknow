# G2 todo 首次多行：改 schema 还是改回执

- Map: [主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）](../agent-control-surface-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-11，操作员裁 A)
- Blocked by: —

## Question

会话 `ffff123c-…` 证明模型会 `todo_write(mode=add, item=[...多步])`，被 ajv 打回后改成单行 `add`。ADR-0046 故意让 `add` 只收 string、`replace` 收 `items`。到达 destination 时闸放哪：

- A：schema 允许 `add` 的 `item` 为 string | string[]（或首次空账本时 add 数组＝replace）。
- B：保持 schema，validation 回执点名 `mode=replace` + `items`（硬闸文案，补轨迹集；不动 soul）。
- C：只改 description / SKIP_CLAUSE（prompt-development 不推荐当唯一修复）。

需要对照黄金名册：`todo_write` 目前无轨迹集。本票不写代码。

## Resolution

操作员否决 B/C：多步计划就应该一次 `add` 进去，不该先失败再改 `replace`。`replace` 是整表换掉，不是「写下计划」的主路径。

对照 prompt-development「说明书不是闸」：模型第一次用数组 `add` 是对的意图，窄 schema 才是错的。落地：`add` 收单条 `item` 或一次多条 `items`（追加，不覆盖）；`replace` 仍整表替换。补轨迹集：`add` + 多条 `items` → 账本 N 行 open。不动 soul。触及 ADR-0046。

## Amendment（2026-09-11）

目标态扩大（操作员同意，跨主会话除外）：账本按条 id；三件事——添加（可批量）、按 id 更新（文案/状态/删）、读取列表。子代理与父会话共用**同一份**会话账本（id 在同一会话内有效）。不拆第四件「只读一条」工具。`replace` 降为整表作废逃生口。跨**主会话**共用一份账本 / 同一 id 不在本切片（见地图 Not yet specified）。
