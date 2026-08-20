# 0018. goal 是用户固定锚、taskFocus 是确定性任务焦点；模型对两者零写入路径

Date: 2026-08-16
Status: accepted; superseded-by ADR-0024 §判定公式 only

Context: #408 的 `session.goal` 一字段两用，混淆「用户固定锚」与「模型可推进活对象」两个角色；#458 map 的 #459/#461/#460 决议要求拆分，并整体裁剪 #432 的 T6 propose/confirm 侧通道。

Decision: 拆成 `session.goal`（只由 `/goal <text>` / `## GOAL: <text>` 写入，`source = user_pin`，模型不可写，仅 `/goal clear` 清除）+ `session.taskFocus`（确定性提取、v1 不用 LLM、仅 compact 边界渲染）。旧盘 `goal.source === "user_initial"` 迁移为 `taskFocus`；`model_proposed` 从 `GoalSource` / `VALID_GOAL_SOURCES` / trace 彻底删除；task 取值公式唯一口径 = `goal.text ?? taskFocus.text ?? query`（判定层只读不回写）。两个 goal 写入入口统一过 `validateGoalText`（非空 + ≤ 2000）。

Why: 单字段混用让模型能漂移用户使命；拆分后权限边界（用户写 goal / 系统确定性写 taskFocus / 判定层只读消费）成为类型级事实。schema 加可选字段按 #120 先例不 bump 版本（`CURRENT_SCHEMA_VERSION` 维持 5）。

Evidence: `specs/458-goal-lifecycle-taskfocus.md`（ACR PASS 5/5）；`plans/458-goal-lifecycle-taskfocus.md`（T1 决策 bullet 定稿 OQ2 切换算法 / OQ3 不 bump）。
