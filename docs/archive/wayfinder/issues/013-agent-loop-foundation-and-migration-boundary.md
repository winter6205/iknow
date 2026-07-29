---
title: 确定 Agent Loop 地基与旧内核替换边界
label: wayfinder:grilling
status: closed
parent: ../maps/agent-loop-foundation.md
assignee: user-and-kiro
---

## Question

项目如何从几乎不可依赖的旧 Agent loop 重新建立第一阶段地基，同时复用现有工具与领域资产，并避免把成熟 Harness、知识、记忆和产品能力混进最小循环？

## Resolution

### Migration position

这不是完全重启。现有知识工具、检索、评测、CLI 和 Session API 是候选复用资产；旧 `src/agent-loop/` 只作为行为基线和迁移输入，不再默认作为后续能力的可靠底座。

新路径只重建“模型调用 → 工具调用 → 真实结果回填 → 下一轮 → 明确停止”。Loop 对具体工具数量和业务名称无知，现有工具通过 Adapter 接入，不能借迁移重写工具业务内部。

### Two delivery gates

- **Gate A：最小顺序 Loop**。先建立 append-only 历史、有限轮次、模型回合、通用工具执行和替身闭环验证。
- **Gate B：必要加固与迁移**。Gate A 通过后，只增加真实产品接入需要的错误、取消、资源护栏和最小 trace，随后迁移调用方并隔离或退役旧 loop。

Gate B 不得反向扩大 Gate A。记忆、Checkpoint、上下文压缩、并行调度、Web、完整评测和生产能力继续由后续地图拥有。

### Minimum state decision

Gate A 的权威状态起点是 append-only `messages` 与 `turnCount`；`maxTurns` 是运行配置。待执行调用、最后输出、最终回答等语义不得建立与历史竞争的第二份权威副本。

### Assistant tool-call decision

assistant 文本和 tool call 必须按 content block 类型区分，但 tool call 仍属于同一 assistant 回合，不创建新的角色。完整 assistant 响应进入权威历史；供 Executor 使用的 tool calls 是从该响应提取的执行视图，不单独成为权威状态。

如果同一 assistant 回合同时包含文本和 tool call，只要存在 tool call 就继续工具闭环；该文本不能单独被视为最终回答。具体类型、供应商字段保真和多个调用表示由 014 细化。

### Excluded project signals

- `harness-lab/` 与 lesson 是教学材料，不代表项目实施；
- `iknow-prototype/` 是视觉实验，不决定 runtime 或产品进度；
- 已完成的知识证据决策继续有效，但实施等待 Foundation 迁移完成。

## Follow-up tickets

- [014：冻结模型回合与 append-only 历史契约](./014-model-turn-and-history-contract.md)
- [015：冻结工具 ACI 与结果回填边界](./015-tool-aci-and-result-boundary.md)
- [016：实现并验证最小顺序 Agent Loop](./016-minimum-sequential-agent-loop.md)
- [017：按迁移需要加固 Agent Loop](./017-loop-hardening-for-migration.md)
- [018：迁移产品路径并退役旧 Agent Loop](./018-migrate-and-retire-legacy-loop.md)

这些票按 `014/015 → 016 → 017 → 018` 推进。具体接口、文件、验证样例和完成证据由用户逐票细化，不在本决策票预先展开。
