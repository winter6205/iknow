# 0024. 完成判定分成 HITL 与 `/goal` 自动模式两套逻辑模块

Date: 2026-08-20
Status: accepted

产品口：本文「自动模式」= **goal 功能**（斜杠钉使命后的续跑），不是权限 `full_auto`。活人读 ADR-0032 + CONTEXT「自动模式」「goal 功能」。

Context: 字段已拆成 goal/taskFocus，但 verify 仍用一条 `goal ?? query`（及更早的 taskFocus）链，把 HITL 聊天接成完成向 LLM 判官；`/goal` 也没有独立自动循环。

Decision: 同一套只读判官系统挂两套逻辑模块。正常模式（HITL）不请 LLM 评语义完成；`/goal` 钉上即自动循环，`task` 仅 `goal.text`，成功也评，停档为 Impossible 清 goal / 空转停循环不清 goal / 不可恢复错误清 goal。无默认轮次硬顶；命令可可选指定上限。自动模式内不存在 taskFocus（`session.taskFocus` 字段已由 ADR-0026 退役；compact 改任务摘录，自动模式不贴）。ADR-0017 的 checker 三级流 shape 保留；其「SUFFICIENT 永不请判官 / INSUFFICIENT 必请」仅覆盖完成向邀请。ADR-0018 的字段拆分与模型零写入保留；判定层三段公式作废。

Why: 参考 Claude Code 默认聊天 vs `/goal` Stop hook；统一公式是职责错配。

Evidence: specs/verify-goal-gate.md；issue #569 grilling。
