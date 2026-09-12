---
name: debug-stop
description: Debug 止损规则 4 阶段 — 3次失败 / 2轮 max_turns / 子失败 / 单文件 500 行
type: feedback
provenance: V 6/20 立约 (配套 testing-standards-v6-20 + subagent-delegation-rules-v6-20)
---

## Debug 止损规则 (2026 v2 — minimax + superpowers 集成)

| 阶段 | 条件                             | 动作                                                                         |
| ---- | -------------------------------- | ---------------------------------------------------------------------------- |
| 1    | 同问题 3 次修复失败              | 停止, **加载 `systematic-debugging` skill**, 重写 prompt, 从头再来           |
| 2    | 2 轮 max_turns 不够              | 拆分为更小的子任务 + **加载 `dispatching-parallel-agents` skill** 派子 Agent |
| 3    | 子 Agent 也失败                  | 缩小目标范围到最小可验证单元 + **加载 `dispatching-parallel-agents` skill**  |
| 4    | 子 Agent 单个文件修改超过 500 行 | 停止, 要求分拆文件                                                           |
