# Company Brain：Map 与 Ticket 执行顺序

核心原则：**先完成 Agent Loop Foundation，再实施 runtime 与知识组件，最后集成 Company Brain v0。**

## 一、当前结论

现有项目不是空白，但旧 Agent loop 不能继续作为可靠底座。013 已关闭并确定：不完全重启；复用现有工具资产；先做 Gate A 最小顺序 Loop，再做 Gate B 必要加固与迁移。

014/015 的模型与工具契约已经冻结。016 的 5 项 to-refine（接口形状、依赖与状态、轮次语义、多调用策略、fixture 矩阵、目标文件/迁移/证据）已通过 Q1–Q6 逐项细化收口。当前下一步是 016 handoff 至实施（spec-driven-development 或 writing-plans），不再细化；这不等于已经授权代码实施，实施仍须走 handoff 确认。

```text
013 地基与迁移边界（closed）
 ├── 014 模型回合与历史契约（closed）─┐
 └── 015 工具 ACI 与结果边界（closed）─┤
                                      ▼
                             016 Gate A 最小 Loop（NEXT）
                                      │
                                      ▼
                             017 Gate B 必要加固
                                      │
                                      ▼
                             018 迁移并退役旧 Loop
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                 Agent Runtime v0        Knowledge Evidence v0
                         └────────────┬────────────┘
                                      ▼
                              Company Brain v0
                                      ▼
                           Production Company Brain
```

## 二、Map 与 ticket 状态

| 项目 | 状态 | 当前动作 |
| --- | --- | --- |
| [Agent Loop Foundation](./maps/agent-loop-foundation.md) | `open` | 完成 016–018 |
| [013 地基与迁移边界](./issues/013-agent-loop-foundation-and-migration-boundary.md) | `closed` | 不再扩展；细节移交后续票 |
| [014 模型回合与历史契约](./issues/014-model-turn-and-history-contract.md) | `closed` | Anthropic 原生历史与 Model Adapter 契约已冻结 |
| [015 工具 ACI 与结果边界](./issues/015-tool-aci-and-result-boundary.md) | `closed` | Registry、Executor 与结果回填契约已冻结 |
| [016 最小顺序 Agent Loop](./issues/016-minimum-sequential-agent-loop.md) | `refined`（Q1–Q6 收口完成） | 等待 handoff 至 spec-driven-development / writing-plans 实施 |
| [017 Loop 必要加固](./issues/017-loop-hardening-for-migration.md) | `blocked` | 等待 016 的真实结果 |
| [018 迁移并退役旧 Loop](./issues/018-migrate-and-retire-legacy-loop.md) | `blocked` | 等待 017 |
| [Agent Runtime v0](./maps/agent-runtime-v0.md) | 决策 `closed`、实施 `blocked` | 等待 018 |
| [Knowledge Evidence v0](./maps/evidence-grounded-knowledge-v0.md) | 决策 `closed`、实施 `blocked` | 等待 018 |
| [Company Brain v0](./maps/company-brain-assistant.md) | `blocked` | 等待 Foundation 与组件实现 |
| [Production Company Brain](./maps/production-company-brain.md) | `parked` | 等待 v0 接受运行 |

`closed` 只表示对应决策完整，不表示代码或产品完成。

## 三、Foundation 执行规则

### 014：模型回合与历史契约

Anthropic 原生消息是 Gate A 权威历史；Model Adapter 原子校验完整 assistant 回合并提供有序 text/tool-call 投影，同时负责编码工具执行结果为原生 `tool_result` user message。

### 015：工具 ACI 与结果边界

Tool/Registry/Executor 使用同源 JSON Schema 完成不可变注册、严格校验和真实执行；Executor 返回身份匹配的 `ToolExecutionResult`，不拥有 Anthropic 消息编码。

### 016：Gate A 最小闭环

014/015 已冻结，016 负责细化并实现：模型 → 工具 → 真实结果 → Adapter 原生编码 → 下一轮 → completed/maxTurns。使用替身 model/tool 验证，不接产品流量。

### 017：Gate B 必要加固

只根据 Gate A 与产品接入暴露的真实失败增加错误、取消、超时、资源护栏和最小 trace；禁止预建成熟 Harness 平台。

### 018：迁移与退役

通过 Adapter 接入现有工具，按冻结顺序迁移 CLI、Session API、LLM Agent 和相关评测路径；新旧 Loop 不长期并行承担产品流量。

## 四、Foundation 之后

1. **组件实施**：Agent runtime 在新 Loop 上增加私有偏好、ContextBuilder、Checkpoint 和恢复；知识证据实施 corpus、检索、source 过滤和证据卡。
2. **产品集成**：新 Loop、真实知识工具、runtime、Web 和评测收据形成一条垂直切片。
3. **基线与 threshold**：先运行最简单完整基线，再按真实失败冻结阈值。
4. **条件式修复**：只修复有失败证据的问题；图谱仍受 006 阻止。
5. **最终接受运行**：四验证包全部通过后，才决定是否进入 production map。

## 五、当前边界

### Ready

- 一次只细化 016 的一个问题；
- 014/015 已冻结，016 可以直接消费其契约；
- 更新 016 票据内容不等于授权代码实施。

### Blocked

- 未完成用户细化前的 016 代码实施；
- 017–018 的代码实施；
- 知识 corpus/检索/证据卡；
- durable memory、Checkpoint 与恢复；
- Web 新功能、四包接受运行、图谱实验与所有生产实施。

### Forbidden

- 把教学 lesson/lab 或视觉原型当作项目进度；
- 绕过 014/015 冻结契约另建消息或工具模型；
- 当前规划具体工具数量或重写知识工具；
- 同时建设第二套知识、runtime、Web 或评测内核；
- 在没有可观察失败时预建复杂记忆、并行调度、多代理或生产平台。

## 六、下一步

[016：实现并验证最小顺序 Agent Loop](./issues/016-minimum-sequential-agent-loop.md) 的 5 项 to-refine 已通过 Q1–Q6 逐项细化收口（见 016 ticket Resolution）。下一步是 016 handoff 至实施：默认走 `arthurpower:spec-driven-development`（把 Decisions-so-far 折叠成可建 spec），或 `arthurpower:writing-plans`（skip spec，仅当该票 Resolution 已含 Problem / Solution / Implementation / Testing / Out-of-Scope 五段时）。Wayfinder 路由目标由用户通过 AskUserQuestion stop gate 确认；本次会话不自动路由。不得借 016 重开 014/015、接入产品流量或提前建设 Gate B。
