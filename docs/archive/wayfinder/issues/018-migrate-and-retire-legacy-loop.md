---
title: 迁移产品路径并退役旧 Agent Loop
label: wayfinder:implementation
status: open
parent: ../maps/agent-loop-foundation.md
assignee: null
blocked_by:
  - 017-loop-hardening-for-migration
---

## Intent

通过 Adapter 接入现有工具，将 CLI、Session API、LLM Agent 和相关评测调用路径迁移到新 Loop，并隔离或退役旧 deterministic/LLM loop。

## Fixed boundary

- 现有工具作为外部依赖接入，不借迁移重写其业务内部；
- 旧代码只作为行为基线与候选适配资产，不决定新内核结构；
- 不长期维护两套承担产品流量的 Loop；
- 不在本票实施后续知识、记忆、Checkpoint 或 Web 新能力。

## To refine before implementation

由用户逐项补充：

- 首个接入工具与 Adapter 边界；
- 调用方迁移顺序；
- 必须保留的外部行为与回归证据；
- 切换、回退、隔离和删除旧路径的条件；
- 目标文件、验证入口与完成证据。

## Exit condition

至少一个现有工具和真实产品调用路径使用新 Loop；旧 Loop 已隔离或退役；后续 runtime/knowledge 组件只有一个默认循环底座。
