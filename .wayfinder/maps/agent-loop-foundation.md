---
title: Agent Loop 运行内核地基
label: wayfinder:map
status: open
tracker: local-markdown
---

## Destination

在不重做现有知识工具的前提下，建立一个可替换旧 Agent loop 的最小运行内核：模型产生工具调用，runtime 执行真实工具，将结果追加回协议历史，模型依据环境结果继续推理并明确停止。

本地图是 [Agent 会话运行时 v0](./agent-runtime-v0.md) 与 [可追溯知识证据子系统 v0](./evidence-grounded-knowledge-v0.md) 进入实际集成前的共同地基。它不是另一个产品原型，也不独立证明 Company Brain 的产品价值。

## Why this map exists

现有项目已经有知识工具、评测、CLI、Session API 和旧 loop，但旧 loop 不能继续默认作为记忆、恢复、知识证据与产品验收的可靠底座。此前把 runtime、knowledge 与产品实现平行铺开，掩盖了它们对同一可信循环内核的依赖。

本地图只修复这个基础层，不推翻已经完成的领域决策，也不把教学材料或视觉实验计入项目实施进度。

## Guide-derived principles

- 从最简起步，先证明闭环，再按真实失败增加复杂度；
- 使用显式 ReAct 循环：模型 Action → 真实环境 Observation → 下一轮模型；
- append-only 消息历史是唯一事实来源；
- 工具通过统一 ACI 注册、校验、执行并返回匹配结果；
- 最小循环必须有有限轮次和可重放验证；
- 记忆、Checkpoint、并行调度、完整安全平台与生产能力后置。

基础边界由 013 持有；具体消息、工具和转换契约分别由 014–016 细化，不在 map 中重复。

## Decisions so far

- [确定 Agent Loop 地基与旧内核替换边界](../issues/013-agent-loop-foundation-and-migration-boundary.md) — 不完全重启；复用工具资产，以 Gate A 最小顺序 Loop 和 Gate B 必要加固迁移替换旧内核。
- [冻结模型回合与 append-only 历史契约](../issues/014-model-turn-and-history-contract.md) — Gate A 采用 Anthropic 原生消息作为权威历史，由协议 Adapter 原子提交完整回合并提供非权威 text/tool-call 投影；OpenAI-compatible 后置。
- [冻结工具 ACI 与结果回填边界](../issues/015-tool-aci-and-result-boundary.md) — Registry 使用同源 JSON Schema 构造不可变工具集；Executor 严格校验并产生 `ToolExecutionResult`，Anthropic Model Adapter 负责编码原生 `tool_result` 消息。
- [细化最小顺序 Agent Loop 的实施契约](../issues/016-minimum-sequential-agent-loop.md) — Loop Engine 对外公开 `run()` + `step(state, deps)->Transition` 状态机；无可变实例状态、state 线程化；`turnCount` 每回合 +1、`maxTurns` 调用前检查；消费 014/015 串行/无短路/无重试契约；fixture 矩阵 S1–S11；目标 `src/harness/` + `tests/harness/`，完全不碰旧 `src/agent-loop/`。决策细化完成，待 handoff 至实施。

## Delivery gates

### Gate A — Minimum sequential loop

建立最小顺序循环及其替身验证，证明：

- assistant 响应、工具调用和真实工具结果形成有效的 append-only 历史；
- 无工具调用时完成，达到轮次上限时停止；
- 工具失败能作为真实结果回到下一轮，而不是被模型伪造或被 runtime 隐藏；
- Loop Engine、Model Adapter 与工具执行边界相互独立。

### Gate B — Necessary hardening and migration

Gate A 通过后，只增加产品路径真实需要的错误、取消、资源护栏和最小 trace；随后通过 Adapter 接入现有工具，迁移调用方并隔离或退役旧 loop。

Gate B 不得反向扩大 Gate A，也不得借迁移之名重写知识工具内部。

## Tickets and blocking edges

```text
013 决定 Foundation 契约
 ├── 014 模型回合与历史契约（closed）─┐
 └── 015 工具 ACI 执行边界（closed）───┤
                                      ▼
                         016 实现并验证 Gate A（NEXT）
                                      │
                                      ▼
                         017 必要加固 Gate B
                                      │
                                      ▼
                         018 迁移并退役旧 loop
```

- [013：确定 Agent Loop 地基与旧内核替换边界](../issues/013-agent-loop-foundation-and-migration-boundary.md) — 已关闭；冻结非完全重启、Gate A/Gate B 与职责边界。
- [014：冻结模型回合与 append-only 历史契约](../issues/014-model-turn-and-history-contract.md) — 已关闭；冻结 Anthropic 原生历史、Adapter、投影、停止与协议错误边界。
- [015：冻结工具 ACI 与结果回填边界](../issues/015-tool-aci-and-result-boundary.md) — 已关闭；冻结 Registry、严格校验、Executor、执行结果与多调用顺序。
- [016：实现并验证最小顺序 Agent Loop](../issues/016-minimum-sequential-agent-loop.md) — 已细化（Q1–Q6 收口）：接口形状、依赖与状态、轮次语义、多调用策略、fixture 矩阵、目标文件/迁移限制/完成证据均已定。待 handoff 至实施。
- [017：按迁移需要加固 Loop](../issues/017-loop-hardening-for-migration.md) — 被 016 阻塞。
- [018：迁移产品路径并退役旧 Loop](../issues/018-migrate-and-retire-legacy-loop.md) — 被 017 阻塞。

014/015 的决策契约已冻结。016 已细化完成；017–018 仍须逐票细化具体接口、文件与验收后才能实施。

## Explicitly out of scope

- 规划 Company Brain 的具体工具数量或业务拆分；
- 修改现有知识工具的业务内部；
- corpus、证据卡、source 过滤、GraphRAG 或图谱；
- durable memory、上下文压缩、Checkpoint 和跨进程恢复；
- Web/CLI 产品体验、流式 UI 和 Session API 扩展；
- 正式四验证包、threshold manifest 和生产级评测；
- 多代理、动态工作流、生产认证、多租户和企业数据生命周期。

## Dependency position

```text
Agent Loop Foundation
        │
        ├───────────────┐
        ▼               ▼
Agent Runtime v0    Knowledge Evidence v0
        └───────┬───────┘
                ▼
        Company Brain v0
                ▼
      Production Company Brain
```

只有 018 完成后，两个 v0 component map 才解锁实际集成。关闭本地图只表示运行内核地基可用，不表示后续组件或 Company Brain v0 已完成。

## Completion gate

- 013–018 全部关闭；
- Gate A 最小闭环通过其冻结验收；
- 至少一个现有工具无需修改业务内部即可接入；
- 产品调用路径已迁移到新内核；
- 旧 loop 已隔离或退役，不再作为后续能力的默认底座。
