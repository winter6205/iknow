---
title: 确定企业数据保留、删除与 legal hold 契约
label: wayfinder:grilling
status: open
parent: ../maps/production-company-brain.md
assignee: null
blocked_by:
  - 005-evaluation-and-verification-gate
---

## Origin

本 ticket 从原 `004-agent-memory-boundaries` 与 `008-conversation-state-context-and-recovery-contract` 中迁出，保留此前已确定的数据生命周期边界，并集中承接尚未决定的企业保留、物理删除、加密和 legal hold 政策。它与会话并发/恢复、私有记忆业务生命周期和知识审批解耦，不阻塞 v0。

## Question

生产级 Company Brain 中，正式 source 与派生索引、私有记忆、Conversation Log、Model Protocol State、Checkpoint、工具收据、审计事件和备份分别保留多久；用户删除、管理员策略、合同义务与 legal hold 冲突时如何裁决；删除和加密状态如何传播并可验证？

## Decisions carried forward

- 不采用无依据的统一七天规则，也不为所有资产设置同一个 TTL。
- 业务状态失效与物理删除分离：`revoked`、`expired`、`superseded` 或会话结束会停止正常召回，但是否以及何时物理删除由明确的数据政策决定。
- Checkpoint 只是恢复索引和执行状态快照，不替代完整会话事件或供应商协议状态，因此不能用删除 Checkpoint 冒充删除会话数据。
- 私有记忆的撤销、替换与过期保留最小审计历史；物理删除、匿名化和 legal hold 由本票统一决定，不能由记忆模块自行发明规则。
- 企业正式 source 删除或撤销后，派生 chunk、向量、事实、摘要、缓存和引用索引必须能够追溯并重建或清除；不能只删一个展示层记录。
- 不可访问或已删除数据不得通过日志、标题、计数、缓存、工具收据、备份恢复结果或“曾经存在”的措辞侧漏。
- reasoning/thinking、签名、工具参数和结果属于敏感协议数据，必须纳入访问控制、日志脱敏、加密和删除范围，而不是当作普通调试文本无限保留。

## Decisions still required

- 为每类资产建立数据分类、处理目的、法定/合同依据、默认保留期和最长保留期；
- 用户删除、tenant 终止、员工离职、source 撤销、项目关闭和安全事件分别触发哪些逻辑与物理动作；
- legal hold 的授权主体、适用范围、通知、解除和防篡改审计；
- 主存储、搜索索引、缓存、日志、对象存储、备份和灾备副本的删除传播与可验证 SLA；
- envelope encryption、密钥轮换、tenant/key 隔离、密钥销毁与恢复流程；
- 审计所需最小留存与数据最小化、用户访问/导出/纠正/删除权之间的裁决；
- 删除失败、部分删除和备份重新导入时的隔离、重试、证明与告警；
- 开发、评测和生产环境之间的数据复制限制与脱敏要求。

## Scope boundary

本票只决定跨资产的数据治理与合规契约：

- 私有记忆的业务作用域、确认、召回和逻辑状态由 011 决定；
- 企业知识的 proposal、审批、发布和 source 版本由 007 决定；
- 会话并发、工具接管、Checkpoint 恢复和模型协议迁移由 009 决定；
- 身份、tenant 和访问授权由 010 决定。

本票不阻塞 `005-evaluation-and-verification-gate`。只有生产地图 entry gate 通过，并获得适用法域、合同和企业政策输入后才能关闭；在这些输入缺失时不得凭技术偏好虚构保留期限。
