---
title: Agent 会话运行时 v0
label: wayfinder:map
status: closed
tracker: local-markdown
---

## Destination

形成一个可在替身知识工具下独立验证的 Agent 会话运行时契约：可信 host/runtime 注入身份与策略，Agent 在有界工具循环中使用私有偏好和企业证据，保持 Anthropic 原生协议连续性，并能对完整回合建立 Checkpoint、在中断后保守恢复或明确阻断。

本地图只记录 v0 runtime 的决策边界，不执行实现，也不承担 Web 产品体验或知识检索质量。

## Foundation dependency

本地图的实际实施被 [Agent Loop 运行内核地基](./agent-loop-foundation.md) 阻塞。现有 `src/agent-loop/` 只作为遗留行为基线与候选适配资产，不再默认视为后续记忆、上下文和恢复能力的可靠底座。

在基础 map 关闭前，本地图只保留已经完成的 003/004/008/005 决策，不实施 durable 私有记忆、ContextBuilder、Checkpoint 或恢复。基础 map 通过后，先把现有工具通过 Adapter 接入同一 loop，再按真实需要逐层增加本地图能力。

## Scope boundary

本地图负责：

- Agent 工具调用、调用顺序、停止原因和资源预算；
- host/runtime 注入主体、allowlist、corpus/策略快照和不可绕过的执行边界；
- session 与明确确认的 durable 私有偏好；
- Conversation Log、Model Protocol State、Checkpoint 和 Working Context 的职责分离；
- Anthropic 原生工具链连续性、Context Gate、单写者状态机；
- 工具幂等身份、执行状态、收据、中断恢复和 `recovery_blocked`。

知识工具可以由测试替身实现，只要保持 003 的业务接口和审计信封。Web 页面、真实检索算法、图谱和最终产品接受门不属于本地图。

## Decisions

- [003：确定 v0 Agent 接口与工具契约](../issues/003-v0-agent-interface-and-tool-contract.md) — 本地图继承统一只读工具表面、runtime 注入不可扩大、工具调用审计、有界循环和停止行为条款；知识检索实现与 Web 呈现由其他地图拥有。
- [004：确定 v0 私有 Agent 记忆边界](../issues/004-agent-memory-boundaries.md) — 只支持 session 偏好和用户明确确认的少量 durable 偏好，按测试主体隔离，可查看、替换与撤销，不保存企业事实或权限。
- [008：确定 v0 会话状态与 Anthropic 协议连续性契约](../issues/008-conversation-state-context-and-recovery-contract.md) — 使用原生协议载荷、逐回合 Checkpoint、单写者状态机、Context Gate 和保守条件恢复。
- [005：确定 v0 评测与验证门槛](../issues/005-evaluation-and-verification-gate.md) — 本地图继承 Agent 证据使用与停止行为、私有记忆包、会话连续性与恢复包、资源预算和相关硬失败条款；最终四包接受门仍由产品地图拥有。

## Completion record

本地图在迁移时已关闭，因为 v0 所需的 Agent runtime 决策均已由 003、004、008 和 005 确定：

- runtime 与模型权限边界明确；
- 最小私有记忆作用域和生命周期明确；
- 协议状态、上下文、Checkpoint 与恢复语义明确；
- 对应自动验证包和硬失败已经定义。

关闭只表示决策契约完整，不表示 runtime 已实现或通过端到端评测。实现细节应进入后续 Spec；真实运行结果若暴露新的架构决策，再创建有具体失败证据的 ticket。

## Relationship to product acceptance

[Company Brain v0 产品集成地图](./company-brain-assistant.md) 将本 runtime 与 [知识证据子系统](./evidence-grounded-knowledge-v0.md) 集成后运行最终验证。Agent 错误不得自动归因于检索；知识候选正确也不能抵消协议、记忆、source 或恢复硬失败。

## Out of scope

- Web UI、流式交互和引用浏览体验；
- corpus、召回、排序、关系检索和知识图谱；
- 多设备、多 worker、长任务接管、跨供应商迁移和灾难恢复；
- 生产身份认证、完整 ACL、多租户隔离和企业数据生命周期。

生产扩展继续由 [生产级多用户 Company Brain 地图](./production-company-brain.md) 管理。
