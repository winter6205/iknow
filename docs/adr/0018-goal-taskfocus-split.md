# 0018. goal 是用户固定锚、taskFocus 是确定性任务焦点；模型对两者零写入路径

Date: 2026-08-16
Status: superseded by 0026

现行: 仍有效 — `session.goal` 用户固定锚（`/goal` / `## GOAL:`，`source = user_pin`）与模型零写入。已废 — `session.taskFocus` 字段、判定层 `goal.text ?? taskFocus.text ?? query`。活人读 ADR-0024（判官模块）+ ADR-0026（任务摘录）。

Context: `session.goal` 一字段两用，混淆「用户固定锚」与「模型可推进活对象」两个角色；goal 生命周期地图的系列决议要求拆分，并整体裁剪此前 scheme 的 propose/confirm 侧通道。

Decision: 拆成 `session.goal`（只由 `/goal <text>` / `## GOAL: <text>` 写入，`source = user_pin`，模型不可写，仅 `/goal clear` 清除）+ `session.taskFocus`（确定性提取、v1 不用 LLM、仅 compact 边界渲染）。旧盘 `goal.source === "user_initial"` 迁移为 `taskFocus`；`model_proposed` 从 `GoalSource` / `VALID_GOAL_SOURCES` / trace 彻底删除；task 取值公式唯一口径 = `goal.text ?? taskFocus.text ?? query`（判定层只读不回写）。两个 goal 写入入口统一过 `validateGoalText`（非空 + ≤ 2000）。

Why: 单字段混用让模型能漂移用户使命；拆分后权限边界（用户写 goal / 系统确定性写 taskFocus / 判定层只读消费）成为类型级事实。schema 加可选字段按 session-persistence 先例不 bump 版本（`CURRENT_SCHEMA_VERSION` 维持 5）。

Supersede chain: ADR-0018 §判定公式 was superseded by ADR-0024（verify/goal 系列整改后）. ADR-0018 §taskFocus 常驻 + compact 焦点渲染 was superseded by ADR-0026（任务摘录系列整改后）. `session.goal` 拆分与模型零写入仍成立。See ADR-0026 for compact 现抽现贴 ≤3 句合格用户任务原文（任务摘录取代 `session.taskFocus` 字段与 240+history+cap720 焦点渲染）。

Evidence: 配套 spec ACR PASS 5/5（后被任务摘录整改取代并归档）；其决策 bullet 定稿 OQ2 切换算法 / OQ3 不 bump。Replacement: ADR-0026（recent-user-tasks spec）.
