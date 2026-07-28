---
title: 从已验证 v0 到生产级多用户 Company Brain
label: wayfinder:map
status: open
tracker: local-markdown
---

## Destination

在只读 v0 已证明价值与安全边界之后，形成一条通往生产级多用户 Company Brain 的决策路线：接入真实企业 source，实施身份、授权和租户隔离，建立受审计的知识治理、完整私有记忆、可靠会话平台与企业数据生命周期，并满足生产运维要求。

## Entry gate

本地图是后续阶段停车场，不是当前工作队列。`005-evaluation-and-verification-gate.md` 的 `status: closed` 只表示评测协议已经决定，**不表示 v0 已运行或通过评测**。

只有同时具备以下运行证据，本地图才解除阻塞：

1. [Company Brain v0 产品集成地图](./company-brain-assistant.md) 已完成最小端到端实现；
2. 已按 005 完成真实基线、冻结 threshold manifest 和最终候选接受运行；
3. 知识质量、source 隔离、私有记忆、会话连续性四个验证包全部为 `pass`，没有硬失败或未解决的 `needs_review`；
4. 基于价值、风险和成本证据作出明确的“继续产品化”决定。

在此之前，007、009、012 以及生产实现选择都保持 parked；010、011 只保存既有边界，不授权实施。评测未通过时，应优先修正或终止 v0，不得以规划生产架构绕过证据门。

010 和 011 是从早期混合范围 tickets 中迁移出来的 **既有 closed 决策**。它们保留已经形成的边界，不代表 entry gate 通过，也不授权现在实施生产能力。迁移只改变决策所有权，并将它们与 v0 解耦。

## Constraints inherited from v0

- Agent 永远不能通过聊天提升身份、授权范围或租户边界。
- 不可访问资料不得通过标题、计数、摘要、片段、引用或缺口措辞侧漏。
- Agent 不得直接改写或发布企业正式知识；任何提升必须形成可审计、可审批、可撤销的正式 source 版本。
- 私有 Agent 记忆不得成为企业事实、权限来源或团队共享的影子知识库。
- 图谱、复杂检索、跨供应商抽象和分布式基础设施必须由真实评测、规模或风险触发。

## Migrated decisions already closed

- [010：确定生产身份、授权与用户画像边界](../issues/010-production-identity-authorization-and-profile-boundaries.md) — 保留 runtime 注入身份/授权、统一业务接口、检索前过滤、画像不得改变授权，以及私有记忆绑定 tenant+owner 的既有决策。
- [011：确定生产私有记忆的作用域、生命周期与自动化边界](../issues/011-production-private-memory-scopes-lifecycle-and-automation.md) — 保留 task/project/durable 作用域、结构化记录与事件历史、确认和召回规则、生命周期状态及 off/shadow/suggest/auto 模式。

## Parked open decision tickets

这些 ticket 不阻塞 v0，只在 entry gate 通过后推进：

- [007：确定会话信息进入企业知识库的提议、审批与发布流程](../issues/007-enterprise-knowledge-promotion-and-approval.md) — 将会话候选提升为正式知识的阶段 B 治理流程；`blocked_by: 005`。
- [009：确定生产级会话并发、恢复与协议迁移边界](../issues/009-production-session-resilience-and-protocol-migration.md) — 多设备/多 worker 并发、长任务接管、状态迁移、损坏恢复、跨供应商安全边界与灾备；`blocked_by: 005, 008`。
- [012：确定企业数据保留、删除与 legal hold 契约](../issues/012-enterprise-data-retention-deletion-and-legal-hold.md) — 跨 source、索引、记忆、会话、协议状态、日志和备份的数据分类、保留、物理删除、加密与 legal hold；`blocked_by: 005`。

## Decision ownership

- 身份、tenant、owner、角色和授权范围：010；
- 私有记忆业务作用域、确认、召回、逻辑状态和自动化：011；
- 企业知识 proposal、审批、发布、撤销与 source 版本：007；
- 运行中会话并发、工具接管、Checkpoint/协议迁移和灾备：009；
- 跨资产保留、物理删除、加密、日志脱敏、备份传播和 legal hold：012。

任何新问题先归入唯一 owner；不得把身份、记忆、知识治理、会话可靠性和数据合规重新合并成一张总票。

## Not yet ticketed

以下主题只记录为未来候选；在 entry gate 通过且出现真实需求前不拆票、不设计：

- 真实企业 source 的选择、连接、内容分类与导入审计；
- 多 source、每人 OAuth client、federated read 的上线顺序；
- SSO/SCIM、具体 RBAC/ABAC 策略、tenant 生命周期与管理员委派；
- Slack、飞书、Notion 等外部系统集成；
- 容量、可用性、RPO/RTO、区域部署和成本目标的量化取值。

## Out of scope

- 在 v0 验证门关闭前实施上述生产能力；
- 让本地图的 ticket 反向成为 005 的 blocker；
- 因技术偏好提前替换向量数据库、建设 GraphRAG、分布式工作流或通用多模型框架；
- 把公开语料上的受控 source view 结果表述为真实企业部署证明。
