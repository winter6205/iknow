---
title: 确定 v0 会话状态与 Anthropic 协议连续性契约
label: wayfinder:grilling
status: closed
parent: ../maps/agent-runtime-v0.md
assignee: user-and-kiro
blocks:
  - 005-evaluation-and-verification-gate
---

## Question

只读 v0 为了可靠运行和自动评测，最少需要怎样记录一次 Anthropic-first Agent 会话、组装下一轮上下文、延续工具协议状态，并在单会话中断后安全继续而不重复执行有副作用的工具？

## Scope boundary

本 ticket 只决定 **v0 最小可验证会话契约**，不是生产级会话平台设计。v0 假定每个 `session_id` 同时最多有一个活动回合和一个可信 host/runtime。

生产级并发、长任务接管、跨供应商迁移、灾难恢复和企业数据生命周期已经移至 [009](./009-production-session-resilience-and-protocol-migration.md)，不阻塞 005，也不在本票预先设计。具体表结构、字段全集、消息编码、缓存断点和存储技术由后续 Spec 决定。

## Resolution

### 状态资产与协议边界

v0 统一使用 `session_id` 标识会话，并保持四类资产职责分离：用户可见的 `Conversation Log`、Anthropic 原生 `Model Protocol State`、版本化 `Checkpoint`，以及每次模型调用前临时组装的 `Working Context`。

持久化在逻辑上采用按 `session_id` 有序追加的会话事件流作为事实记录；Conversation Log 和 Model Protocol State 是不同投影，Checkpoint 只引用已确认的恢复位置和状态摘要，Working Context 不成为新的真相源。物理上是否分表或分库存储留给 Spec。

事件只使用供应商无关的最小信封承载排序、生命周期、审计和恢复信息；模型语义保留在外加的供应商协议载荷中。v0 直接保存 Anthropic Messages 原生块，不建立会翻译或归一化 `thinking`、`signature`、`text`、`tool_use` 和 `tool_result` 的通用消息模型。

runtime 的工具执行身份与 Anthropic 的协议调用身份保持分离并可审计关联。具体 ID 名称和编码留给 Spec；幂等、执行状态与收据属于可信 host/runtime，而不是模型协议本身。

### 请求组装与上下文边界

Anthropic Messages 调用按无状态请求处理。每次调用前，ContextBuilder 都从当前事实状态重建完整有效的 Working Context；模型只返回本次新增的 assistant 内容，runtime 负责保存响应并在后续请求中延续所需上下文。

每次请求至少保留当前 runtime 规则、测试主体与 allowlist、当前请求、最近有效 Checkpoint 所指向的状态，以及完整活动 Anthropic 工具链。活动工具链中的 `assistant.content[]`、thinking/signature、tool_use 和匹配 tool_use_id 的 tool_result 必须按原顺序原样回传，不得裁剪、重排、翻译或摘要。

ContextBuilder 按 004 的边界加载当前 session 偏好和与当前任务相关的 active durable 偏好；当前明确指令优先于 session 偏好，session 偏好优先于 durable 偏好。偏好是每次请求重建的 runtime 快照，不伪装成聊天历史，也不要求模型在响应中回显。

当前回合已经依赖的企业证据必须随活动链保留。较旧的完整回合和可选偏好可以按相关性与预算省略，但必须记录本次加载项、Token 占用和省略原因。Compaction 只能发生在完整 `end_turn` 或 Anthropic 明确支持的安全边界，不得改写活动工具链；v0 不要求通用语义压缩。

每次 Anthropic 请求前执行 Context Gate。若必需内容与预留输出已经超过模型窗口，则不发送请求并以明确的容量错误停止本回合；不得通过破坏协议链强行生成答案。具体 Token 阈值和计算方式由 Spec 决定。

上下文采用确定性的缓存友好布局：稳定、版本化的规则和工具定义在前，session/回合动态内容在后，历史与活动协议块保持原顺序追加。规则真实变化时切换版本并接受缓存失效。Prompt Cache 只是可丢失的成本与延迟优化，不是会话状态、正确性依据或恢复来源。

### Checkpoint 与最小状态机

创建 session 时建立初始 Checkpoint；之后每个成功完成的 `end_turn` 都建立一个完整、版本化且可校验的 Checkpoint。失败或中断回合不产生伪完整 Checkpoint，但已经持久化的协议事件、工具状态和收据仍然保留。

v0 的最小状态流为：

1. 新建 session，建立初始 Checkpoint，进入可开始回合状态；
2. 在单写者约束下开始回合并记录用户输入；
3. 按顺序记录 Anthropic assistant 块、工具开始和工具结果；
4. 在完整 `end_turn` 后提交回合与新 Checkpoint；
5. 中断后从最近一个完整、校验通过的 Checkpoint 加载，并核对其后的活动协议尾部与工具账本；
6. 只有协议尾部完整且所有已执行工具结果明确时，才条件式继续当前回合；否则进入明确的失败或阻塞路径。

同一 `session_id` 同时只允许一个活动写回合。检测到并发活动回合时拒绝后来的写入，不在 v0 合并、分支或接管。

### 恢复与失败语义

v0 采用保守的条件恢复，不承诺从任意流式 chunk、半截响应或不可验证位置透明续跑：

- 协议尾部完整且工具状态可核对时，可以从已确认边界继续活动工具链；
- 相同参数的只读检索可以安全重放，但必须记录重放；
- 有副作用的私有记忆写入必须具备幂等身份、开始/完成状态和可核对收据；
- 有副作用调用已开始但结果无法确认时，进入 `recovery_blocked`，不得重试工具、继续调用模型或假装操作未发生；
- Checkpoint 损坏、校验失败或版本不兼容时安全拒绝恢复，或由用户明确开始新的 session，不自动修复；
- 活动链因上下文容量无法继续时，保存已发生事件和收据，以明确错误停止，不裁剪协议状态伪造成功。

005 应据此覆盖：新建 session、开始回合、记录模型块、记录工具开始/结果、完成回合、每个完整回合生成 Checkpoint、从有效 Checkpoint 条件恢复，以及未确认副作用、损坏 Checkpoint、上下文溢出和并发写入的保守拒绝路径。
