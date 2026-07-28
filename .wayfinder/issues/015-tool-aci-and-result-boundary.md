---
title: 冻结工具 ACI 与结果回填边界
label: wayfinder:implementation
status: closed
parent: ../maps/agent-loop-foundation.md
assignee: user-and-kiro
blocked_by:
  - 013-agent-loop-foundation-and-migration-boundary
---

## Intent

把 Tool Registry、参数校验、执行与结果格式化的职责冻结为通用 ACI，使 Loop 能执行任意已注册工具，而不拥有具体工具的业务逻辑。

## Fixed boundary

- 工具调用必须经过注册定位、参数校验和真实执行；
- 成功与失败都要形成能匹配原 tool call 身份的结果；
- Observation 的业务事实只能来自 Executor；
- 不在本票决定 Company Brain 需要多少工具，也不修改现有知识工具内部。

## Resolution

### Tool、Registry 与 Executor

- 注册 Tool/Adapter 拥有模型可见的名称、描述、参数 JSON Schema、真实调用入口，以及该工具特有的结果裁剪与内容组织；底层知识工具可以继续返回领域对象，由 Adapter 整理 ACI 输出。
- Registry 保存完整的注册 Tool 集合，负责构造期校验、模型定义列举和按名称定位；它不知道 Loop，也不执行工具。
- Executor 接收 014 的合法有序 tool-call 投影，持有调用身份与原始 input，完成定位、严格校验和真实调用，再返回匹配该身份的 `ToolExecutionResult`。
- `ToolExecutionResult` 只是一次执行的确定性结果/收据，不是供应商无关的 canonical message 或 content-block 模型；它承载调用身份、成功 payload 或安全错误，供 Model Adapter 编码。
- Anthropic Model Adapter 完整拥有原生协议编码：把 `ToolExecutionResult` 确定性地转换为匹配 `tool_use_id` 的原生 `tool_result`，放入合法 user message，并交给 Loop 原样追加。
- Loop 只调度 Executor、把执行结果交回 Model Adapter，并追加 Adapter 交付的原生消息；Loop、Registry、Executor 与 Model Adapter 都不得按 `kb_retrieve` 等具体业务名称分派。
- Tool/Adapter 默认只接收严格校验后的输入；原始调用身份与原始 input 由 Executor 持有。以后若需要取消信号等执行上下文，必须与供应商协议解耦，且不在 Gate A 预建。

### Schema 与参数校验

- Anthropic `input_schema` 与执行前运行时校验必须来自同一份权威 JSON Schema，不允许分别维护，也不通过另一套代码 schema 转换后形成第二份规则。
- Registry 构造时检查重复工具名、JSON Schema 合法性并准备 validator；任一失败即拒绝构造，不能让 Loop 带着坏 Registry 启动。
- Registry 在一次 Loop 运行期间不可变：工具集合、schema 以及名称到实现的映射保持不变。新的独立运行可以使用新 Registry；这不阻止未来在模型暴露层增加按需工具发现。
- Executor 始终执行本地严格校验，即使供应商启用了 strict mode。strict mode 只是额外保障，不能替代 ACI 入口校验。
- 严格校验不做隐式类型转换、不裁剪未知字段、不猜测缺失值；失败时不调用工具，而是形成可修正的错误结果。
- 具体标准兼容 validator 包在实施时确定并固定版本；禁止手写只覆盖部分 JSON Schema 的伪 validator。

### Tool 输出与结果回填

- Tool/Adapter 成功时返回已经过字段选择、排序、截断和说明组织的 JSON-compatible model-facing payload；允许字符串或结构化 JSON 值，不允许 `undefined`、`BigInt`、循环对象、`Map`、`Date`、class instance 等需要 Executor 猜测转换的值。
- Tool/Adapter 决定结果里面说什么；Executor 负责可序列化性防线、成功/失败分类、原始身份匹配和 `ToolExecutionResult` 构造；Model Adapter 只做 Anthropic 原生消息编码，不改变 Observation 的业务含义。
- Anthropic-first 的原生历史决策继承 008/014：assistant 原生 blocks 和编码后的 `tool_result` 消息进入权威历史；runtime 自己的执行身份/收据仍与 `tool_use_id` 分离，跨供应商迁移留给 production 边界。
- 工具不存在、参数非法和工具执行失败都必须形成匹配原始调用身份的失败 `ToolExecutionResult`，再由 Anthropic Model Adapter 编码为 `is_error: true` 的原生 `tool_result`；三类失败在模型可见结果中必须可区分。
- Tool/Adapter 可以通过明确的公开错误类型声明可安全反馈的业务失败；Executor 保留其可操作信息。其他未知异常必须净化为通用执行失败，不得向模型暴露 stack、内部路径、凭据或未审查的底层错误文本。
- 公开错误类型与 `ToolExecutionResult` 的具体 TypeScript 形式及字段拼写不在本票过早固定；实施只需保持稳定可区分、对模型可操作、可无损编码且默认不泄露。
- Executor 不自动重试工具调用。失败立即回填；模型若要修正，必须发出具有新身份的新调用。重试尝试受 016 的 `maxTurns` 约束；基础设施退避、幂等与自动重试策略属于 Gate B。

### 同回合多个调用

- 按 assistant content blocks 中 tool calls 的出现顺序串行执行，并按相同顺序返回执行结果；Gate A 不并行调度。
- 某个调用失败不短路该回合剩余调用。每个已发出的 tool call 都必须得到一个匹配结果，避免历史留下悬空调用。
- 重复或缺失 call identity 属于 014 的模型协议错误；015 只消费 014 校验通过的调用投影，不自行发明身份修复规则。

## Implementation target and evidence

- 014–016 的新 Foundation 放在独立的 `src/harness/` 根目录；015 的实现目标位于其 tools 子模块。不得原地扩展旧 `src/agent-loop/llm-agent.ts` 的业务 `switch`，也不得把现有 `src/tools/registry.ts` 误作通用 ACI Registry。
- 现有 `src/agent-loop/` 保持迁移输入，直到 018；现有知识工具内部不因 015 修改。
- 契约测试使用最小替身工具，不直接引入 store、session 或四个知识工具：至少覆盖成功、公开业务失败、未知异常、工具不存在、严格参数拒绝、坏 schema/重复名称构造失败、同回合顺序以及失败后继续。
- 测试入口放在 `tests/harness/`，随项目现有 Node test runner 执行；实施完成证据包括目标测试、`npm run typecheck` 与完整 `npm test`。
- 至少一个真实知识工具无需修改业务内部即可接入的证据由 018 的 Adapter 迁移提供，不提前污染 Gate A 契约测试。

## Deferred and forbidden here

- 权限确认、沙箱、安全分类、取消、超时、自动重试、并发安全、资源护栏和最小 trace 属于 017 或更后阶段；
- 模型侧动态工具发现、schema 延迟加载和运行期 Registry 热替换不在 Gate A；
- 不规划具体工具数量，不重写知识工具，不建设完整成熟 Harness 平台；
- 015 不重新解释 Anthropic 原生 block、角色或停止原因；这些继续由 014 的 Model Adapter 契约拥有。

## Completion evidence

- 用户已逐项确认 Tool/Registry/Executor 职责、JSON Schema 同源严格校验、不可变 Registry、结果内容与错误边界、零自动重试、同回合串行顺序和独立 Foundation 目标；
- 已与关闭的 014 对齐：Executor 产生 `ToolExecutionResult`，Anthropic Model Adapter 负责原生 `tool_result` 消息编码，Loop 只追加 Adapter 交付的原生消息；
- 013、014 已关闭，上述契约可由 016 使用替身 Model/Tool 直接实现和验证；
- 本票关闭只表示决策冻结，不代表实现代码、测试或产品迁移已经完成，也不自动授权 016 代码实施。
