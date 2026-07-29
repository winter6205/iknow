---
title: 冻结模型回合与 append-only 历史契约
label: wayfinder:implementation
status: closed
parent: ../maps/agent-loop-foundation.md
assignee: user-and-kiro
blocked_by:
  - 013-agent-loop-foundation-and-migration-boundary
---

## Intent

把 013 已决定的模型回合、assistant content blocks 与 append-only 历史边界落实为可实施契约，为最小 Loop 提供唯一、无歧义的模型输入输出形状。

## Fixed boundary

- assistant 文本与 tool call 必须可区分，但仍属于同一个 assistant 回合；
- 只有通过契约校验的完整 assistant 响应才能进入权威历史，供执行使用的 tool calls 是投影视图；
- 不在本票实现工具执行、循环编排、记忆、Checkpoint 或供应商迁移。

## Resolution

### History ownership and protocol boundary

- Gate A 只冻结并验收 Anthropic Messages 协议；OpenAI-compatible Adapter 是未来扩展，不属于 014 或 016 的完成条件；
- Foundation 保留按 protocol family 增加 Adapter 的边界，但不在当前建立跨协议 canonical message/content-block 模型；
- 每段权威历史在创建时绑定一个 protocol family；Gate A 的唯一 protocol family 是 `anthropic-messages`，且不支持同一段历史中途切换协议族；
- 权威运行历史保存 Anthropic 原生消息，Model Adapter 负责解释原生响应并生成后续原生消息；
- 实际 endpoint、上游供应商与是否经过 Gateway 属于 Adapter 配置，不改变历史所属的协议族；
- Loop 与 Executor 使用的文本、tool calls 和完成状态只是从原生回合得到的非权威投影视图；
- OpenAI-compatible 的原生历史、跨协议翻译与会话中途迁移全部后置。

### Assistant content projection

- Foundation 公共层只识别 `text` 与 `tool call` 两类 assistant 语义投影；
- 投影保持它们在原生 assistant 回合中的相对顺序，不把同一回合拆成彼此无关的文本数组与调用数组；
- thinking、signature、citation 及其他供应商专有或未知 blocks 原样保留在权威原生历史中，但 Foundation 不解释；
- Executor 只从有序投影中筛选 tool calls；投影不成为第二份权威状态。

### Model Adapter responsibility

- Model Adapter 完整拥有对应供应商协议的请求组装、模型调用、响应解释与工具结果消息编码；
- Adapter 将原生 assistant 响应解释为 Foundation 的有序 `text` / `tool call` 投影和公共回合结果；
- Adapter 负责供应商协议要求的调用身份匹配、消息角色、顺序与格式校验；
- Loop Engine 不读取、不判断、也不构造任何供应商原生字段；
- Loop Engine 只负责追加 Adapter 交付的原生历史消息、调度执行投影、回交执行结果并管理有限轮次。

### Native payload preservation

- 权威历史只保存可用于后续模型请求的完整原生消息 payload，而不保存整个 API response envelope；
- 原生角色、content blocks、tool-call 字段、thinking/signature 及未知协议字段按供应商要求无损保留；
- response ID、model、usage、延迟、HTTP headers 与 request ID 等传输、计费和观测元数据不进入 `messages`；它们未来可进入独立的非权威调用收据或 trace；
- 原生 payload 以供应商公开的 wire/API 协议语义为准，不绑定任何 SDK 的类、对象或版本；Adapter 可以使用官方 SDK，也可以直接调用 HTTP API，二者不得改变历史契约。

### Multiple tool calls in one turn

- 一个 assistant 回合允许包含零到多个 tool calls；
- 每个调用保留独立的协议调用 ID、工具名称、参数和在原生回合中的出现顺序；
- 多个调用仍属于同一个 assistant 回合，不拆成多个虚构回合；
- 014 只冻结表示、身份和顺序，不决定串行、并行或依赖调度；执行策略由 015 拥有。

### Atomic assistant-turn validation

- Adapter 必须先校验完整原生 assistant 回合，校验通过后才能将该回合原子追加到权威历史并产生执行投影；
- 同一回合任一 block 存在协议结构错误时，整个回合不进入权威历史，也不执行其中任何工具调用；
- 失败以明确的模型协议错误结束当前路径；原始坏响应可以进入独立诊断收据，但不能进入后续模型 `messages`；
- 工具参数 schema 错误属于 015，API 超时、限流和服务端失败的重试与恢复属于后续加固，不与模型协议结构错误混为一类。

### Turn outcome and completion

- “没有 tool call”只是完成的必要条件，不是充分条件；
- 只有 Adapter 将原生停止原因解释为成功结束，且该回合没有 tool call 时，才能成为完成候选；
- 存在一个或多个合法 tool calls 时，公共结果为需要工具；
- 截断、拒绝及其他合法但未完成的供应商结果属于非成功停止：原生消息可以进入历史，但其中的文本不得作为成功最终答案；
- Gate A 对非成功停止只要求明确终止并报告原因，不在 014 设计续写、自动重试或 fallback；
- `finalText` 不是停止依据或权威状态，而是从最后一个成功 assistant 回合的有序 text blocks 派生的结果视图；
- 成功完成还要求至少存在一个包含非空白内容的 text block；供应商报告成功结束但没有可展示文本时，定义为 `EmptyFinalResponse`；
- `EmptyFinalResponse` 不提交到权威模型历史，原始响应只可进入独立诊断收据，以便未来仍能从调用前的有效历史恢复；
- Gate A 对空最终响应立即报错且不自动重试；是否增加有限重试及具体阈值由 017 根据真实失败证据决定，014 不预设“三次”等次数；
- 014 只判断 text block 的协议结构完整性，不判断答案在业务语义上是否充分或正确。

### Streaming boundary

- 流式 text、tool-input 与其他 delta/chunk 只属于 Adapter 内部的临时传输状态，不进入权威历史；
- Adapter 只有在收到完整结束信号、组装出完整原生 assistant 回合并通过整回合校验后，才能将其原子提交到权威历史；
- 中途断流不提交半成品，只产生明确的传输失败和可选诊断收据；断流重试与恢复由 017 决定；
- Gate A 不承担流式 UI，Adapter 是否内部采用流式传输不得改变 Loop Engine 的完整回合契约。

### Offline contract acceptance

- 014 的契约验收以固定 Anthropic Messages JSON 样例离线完成，不连接真实模型、不产生网络费用，也不依赖 SDK；
- 样例至少覆盖：纯文本完成、文本与单个 tool call 同回合、同回合多个 tool calls、截断或拒绝、空最终响应、缺失必要 block/调用身份，以及流中断不提交半回合；
- 验收必须证明完整原生 assistant 回合进入历史、投影不成为第二权威状态、坏回合不提交且不触发工具执行；
- OpenAI-compatible fixtures 与 Adapter 验收后置，不阻塞 014、016 或 Gate A。

### Request configuration versus history

- 权威 append-only 历史只包含 Anthropic 原生对话 `messages`；
- system prompt、工具定义、model 与 tool choice 是每次模型调用的请求配置，不进入 `messages`，也不伪装成 user/assistant 回合；
- Loop 向 Model Adapter 提供历史与当次请求配置，由 Adapter 按 Anthropic 协议组装请求；
- 请求配置的版本快照、审计与恢复不在 014 内预建，留给后续 runtime 或 trace 边界。

### Initial user input

- Gate A 只接收一段非空用户文本，多模态输入后置；
- Anthropic Model Adapter 负责把用户文本编码为原生 user 消息，Loop Engine 只追加 Adapter 交付的原生消息；
- 真实用户输入与借用 Anthropic user role 承载的 tool results 必须保持语义区分；工具结果的公共形状由 015 冻结，Adapter 只负责最终协议编码。

## Implementation handoff

- 本票关闭代表模型回合与历史决策已冻结，不代表代码、测试或产品路径已经实现；
- 015 负责冻结公共工具结果形状和执行边界，Anthropic Adapter 只负责把该结果编码为原生 tool-result 消息；
- 016 负责选择目标文件与测试入口，实现 Anthropic Model Adapter、最小 Loop，并运行本票定义的离线验收矩阵；
- OpenAI-compatible Adapter、多模态输入、跨协议历史迁移、流式 UI、自动重试、trace、记忆与恢复均不阻塞 Gate A。

## Completion evidence

- 用户已逐项确认消息历史、投影、Adapter、原生字段、多调用、原子校验、停止语义、流式边界、请求配置和初始用户输入契约；
- Anthropic 离线验收样例范围已经冻结，可由 016 直接转化为测试；
- 013 已关闭，本票不再阻塞 015 的细化；
- 本票未创建或修改实现代码、测试或依赖。
