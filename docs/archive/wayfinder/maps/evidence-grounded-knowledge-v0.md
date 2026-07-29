---
title: 可追溯知识证据子系统 v0
label: wayfinder:map
status: closed
tracker: local-markdown
---

## Destination

形成一个可脱离 Web 与对话 Agent 独立验证的只读知识证据子系统契约：给定查询、可信 runtime 注入的测试主体与 `allowed_source_ids`，从冻结语料中返回完整、可追溯且不越权的候选证据，并用重复、可审计的评测证据决定是否需要关系召回或知识图谱。

本地图只规划知识检索与证据边界，不执行产品实现。它向 [Company Brain v0 产品集成地图](./company-brain-assistant.md) 提供可替换、可评测的知识能力。

## Scope boundary

本地图负责：

- corpus manifest、冻结语料、问题集和 gold evidence；
- 查询过滤、候选召回、排序、必要文档覆盖和证据卡；
- 检索前 `allowed_source_ids` 过滤与禁止 source 零暴露；
- 稳定 evidence/document/version/locator 身份及边级来源；
- 关系、多跳和跨文档召回的失败归因；
- 知识图谱的条件性职责、实验准入和采用门槛。

本地图的测试入口可以是 API、CLI 或评测 harness。Web 呈现、Agent 工具循环、私有记忆、会话协议和最终自然语言回答不属于本地图。

## Decisions

- [002：确定演示语料与证据契约](../issues/002-demo-corpus-and-evidence-contract.md) — 使用冻结的 Docugami SEC 10-Q 切片、平衡题集、稳定定位符和 claim 级证据契约；关系题不足时才考虑固定 MultiHop-RAG 压力包。
- [003：确定 v0 Agent 接口与工具契约](../issues/003-v0-agent-interface-and-tool-contract.md) — 本地图继承其中 `company_knowledge_search`、runtime 注入 allowlist、检索前过滤、证据卡和检索审计条款；Web 与 Agent runtime 条款仍由产品地图拥有。
- [005：确定 v0 评测与验证门槛](../issues/005-evaluation-and-verification-gate.md) — 本地图继承必要 evidence/document 覆盖、禁止证据暴露、检索层失败归因、动态重复和优化准入条款；最终四包接受门仍由产品地图拥有。
- [006：确定知识图谱的职责与启用条件](../issues/006-graph-role-and-adoption-trigger.md) — v0 不启用图谱；图谱仅可在固定关系子集暴露重复、可审计的候选召回失败，且更小非图方案不足时，由新的有界实验票触发。

## Decision outcome

本地图的决策契约已经关闭：

- 演示语料、问题分类、gold evidence 和 source 视图契约已经确定；
- 知识能力的输入、输出、证据身份、过滤和审计边界已经确定；
- 普通检索、较小非图优化与图方案的职责边界及比较协议已经确定；
- v0 明确使用不含图谱的最简单完整混合检索基线；
- Agent 推理、Web UX 和生产授权问题已移出本地图，不能再误归因于检索。

关闭只表示**可以进入 Spec 与实现**，不表示知识子系统已经实现、运行过基线或达到产品接受门。

## Implementation hold

本地图的知识决策已经完成并继续有效，但实际实施当前暂停，被 [Agent Loop 运行内核地基](./agent-loop-foundation.md) 阻塞。暂停不是重开 002/006，也不是否定语料、证据和图谱门槛；它只纠正实施顺序，避免知识、runtime、Web 和评测在 loop 底座未稳定时横向并行扩张。

基础 map 关闭后，本地图按以下顺序解锁：

1. 冻结 corpus manifest、题集、gold evidence 和开发/保留划分；
2. 实现最简单完整的混合检索、检索前 source 过滤、证据卡和确定性审计；
3. 通过 Adapter 接入已验证的 loop，不把检索业务逻辑写回 loop；
4. 在 API/CLI/评测 harness 下运行知识层基线，记录必要 evidence/document 覆盖与资源数据；
5. 只按 005 的失败归因优化，默认不建设图索引。

任何图谱工作仍被 006 阻止，除非真实基线满足全部实验触发器并新建独立 ticket。

## Relationship to product acceptance

[Company Brain v0 产品集成地图](./company-brain-assistant.md) 可以使用本地图定义的知识能力运行端到端验证。知识层证据召回通过不等于最终回答通过；反之，必要证据已返回但 Agent 未使用时，不得以此批准图谱。

## Out of scope

- Web 对话、引用展开和用户反馈体验；
- Agent 工具选择、上下文组装、私有记忆和会话恢复；
- 真实企业 source 导入、生产 ACL、tenant 隔离和知识发布治理；
- 没有固定失败样本支持的 GraphRAG、向量数据库替换或无界检索优化。
