# G3 何时写、失败怎么兜、能不能覆盖

- Map: [会话列表显示的会话概要（决策）](../session-list-label-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: closed（2026-09-19）
- Blocked by: G1

## Question

G1 若选 LLM（或其它非 `extractTitle` 重算），写策略是什么？

- 触发：首条 user 发出时并行，还是首轮助手完成后？
- 失败 / 无 key / 超时：是否必须留下 `extractTitle` 占位，且对用户静默？
- 之后每次 `extractTitle(messages)` 重算会不会盖掉已生成标题？（现状会随 save 重算）
- 要不要手改入口与 CAS？没有手改的话，「只生成一次」用什么字段当闸（`titleSource`、空则写、还是永远只写一次）？
- 是否默认开、要不要 settings 开关（Hermes `auxiliary.title_generation.enabled`）？

## Resolution（已撤回）

纯派生、不等助手。撤回：随 G1。

## Resolution

首条 user 落盘立刻写 `extractTitle` 占位。第一次 `StopReason=completed` 且已有实质 user 文本后，异步 lite 补全只生成一次，失败静默留占位。之后 save / compact **不得**再用 `extractTitle` 盖掉已有标题事件。闸 = 已有标题事件则跳过。不做给人改名的入口。
