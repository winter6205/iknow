# 0049. 长程 plan/实施/replan 是主代理认知循环；活图是落地，不是规划的超集

Date: 2026-09-08
Status: accepted

Coding agent 的 plan → 实施 → replan 不做成单独 Plan Mode，也不把凡规划都塞进图。主代理（和用户）负责拆任务与改主意；有依赖、要冻结已完成时，分解写入 **活图状态**，实施走 `run_graph`，replan 走 **外环修订**。轻清单仍是 todo 账本（ADR-0046）。规划能力不「包含」graph；graph 是规划在需要结构时的落地。

## Why not

- **凡 plan 必进图**：短任务强制 DAG，摩擦大。
- **plan 文档另当权威**：和活图两份真相，否 ADR-0047。
- **加长 system 教规划**：纪律应落在 schema / 活图账本 / 开图通知；`docs/guides/prompt-development.md` 管怎么改文案，不灌进模型。
