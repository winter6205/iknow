---
title: 确定生产级会话并发、恢复与协议迁移边界
label: wayfinder:grilling
status: open
parent: ../maps/production-company-brain.md
assignee: null
blocked_by:
  - 005-evaluation-and-verification-gate
  - 008-conversation-state-context-and-recovery-contract
---

## Origin

本 ticket 从原 `008-conversation-state-context-and-recovery-contract` 中迁出，保留 v0 之外的生产会话可靠性问题。企业数据保留、删除、加密和 legal hold 已进一步解耦到 `012-enterprise-data-retention-deletion-and-legal-hold`。

## Question

只读 v0 通过价值与安全验证后，生产会话平台怎样处理多设备和多 worker 并发、长任务所有权与故障接管、状态版本迁移、损坏恢复、容量与灾备，以及跨供应商协议的安全边界？

## Scope boundary

本 ticket 是 **v0 后的生产会话韧性决策**。它不阻塞 `005-evaluation-and-verification-gate`，也不得反向扩大 008 的最小单会话契约。

本票不默认要求跨模型迁移 reasoning。若供应商原生 thinking/signature 或其他协议状态不可移植，必须在供应商支持的安全边界结束旧模型链，再以可审计的中立摘要开启新链，而不是伪造连续性。

身份与授权由 010 决定；私有记忆业务生命周期由 011 决定；所有会话资产的保留、物理删除、加密、日志脱敏和 legal hold 由 012 决定。本票只定义运行中状态的一致性和恢复语义。

## Decisions carried forward

- Conversation Log、供应商原生 Model Protocol State、版本化 Checkpoint 和临时 Working Context 保持不同职责；Checkpoint 不替代完整事件或协议状态。
- 活动工具链内不得裁剪、重排、翻译或摘要供应商要求原样延续的协议块。
- Compaction、模型切换或中立摘要只能发生在完整 `end_turn` 或供应商明确支持的安全边界。
- 所有有副作用工具必须记录 `tool_call_id`、幂等键、开始/完成状态和可核对收据；崩溃恢复必须先核验执行结果，不能盲目重试。
- ContextBuilder 必须记录加载了哪些系统规则、身份/权限快照、Checkpoint、历史事件、私有记忆、企业证据和活动工具链，以及 Token 占用与省略原因。

## Questions to resolve

- 多标签页、多设备和多 worker 对同一 `conversation_id` 写入时采用租约、乐观并发、分支还是拒绝策略？
- 长时间工具调用和后台任务如何记录所有权、续租、接管与最终收据，避免重复副作用？
- Conversation Log、Model Protocol State 与 Checkpoint 如何进行 schema/version 迁移、损坏检测和可审计回放？
- 损坏或过期 Checkpoint 采用怎样的降级、隔离、人工修复或重新开始路径？
- Anthropic、OpenAI 或其他供应商之间哪些状态可以迁移，哪些必须在安全边界终止并重新开始？
- 会话容量、归档层级、可用性、RPO/RTO 和区域级灾备目标由什么真实负载与风险触发？
- 模型适配器升级如何做兼容性测试、灰度、回滚和旧会话继续策略？

## Entry criteria

- 005 已记录 v0 基线并证明继续产品化有价值；
- 008 的最小状态机已经形成可执行契约；
- 存在真实的多用户并发、长任务、供应商切换或恢复需求，而不是为了预想中的规模提前设计；
- 每项能力都有可验证的失败场景、风险和验收目标。
