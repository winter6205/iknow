---
title: 按迁移需要加固 Agent Loop
label: wayfinder:implementation
status: refined
parent: ../maps/agent-loop-foundation.md
assignee: null
blocked_by:
  - 016-minimum-sequential-agent-loop
---

## Intent

根据 Gate A 和现有产品接入暴露的真实失败，为新 Loop 增加迁移必需的最小错误、取消、资源护栏与可观测信息。

## Fixed boundary

- 只实现有具体失败或调用方要求支撑的加固；
- 不预建完整权限平台、沙箱、后台任务、自动压缩或生产级 tracing；
- 不改变 Gate A 的核心历史和职责边界。

## To refine before implementation

由用户根据 Gate A 结果逐项补充（已逐项细化，见下方 Resolution）：

- 必须处理的模型/工具/协议错误；
- 取消与在途调用清理需求；
- maxTurns 以外确有必要的时间、token 或成本护栏；
- append-only 历史之外必须记录的最小 trace；
- 目标文件、验证场景与完成证据。

## Resolution（Q1–Q7 细化收口）

### 总览：两层闭合

017 在替身闭环下证据真空（Gate A 是离线脚本实现、新内核完全没接产品流量）。把 017 收口为"物理必需层 + 条件式修复层"两层闭合：

- **物理必需层（本票实施）**：取消、超时、诊断回流形状、停止语义、最小 trace。这五件套的证据是"任何 HTTP agent loop 迁移的物理必需"或"调用方迁移必需"，不需要等真实失败就能确定。
- **条件式修复层（推迟为 017 out-of-scope）**：自动重试、token/cost 护栏、trace B 层字段、工具按 handler 类型细分超时、可重试/不可重试错误分类、总耗时独立 stop 触发器、生产级 tracing 平台。这些必须等 018 真实接通暴露失败后按 013"条件式修复"原则开后续票补，不在当前 017 预建。

017 实施时**严格守左列、绝不夹带右列**（见 Q6 对仗表）。

### Q1 取消能力的生效粒度（signal 透传边界）

**(b') signal 透传到 Model Adapter + Executor，015 ToolHandler 加可选 `ctx?: { signal }`**。

- `run(userText, deps, signal?)` 与 `step(state, deps, signal?)` 加可选 signal 参；`ModelAdapter.step` 加 signal 参；adapter 内部把 signal 绑到 SDK client/fetch。
- `Executor.executeAll(calls, signal?)` 透传；`ToolHandler = (input, ctx?) => ...` 第二参是可选执行上下文含 signal。015 已预留"以后若需要取消信号等执行上下文...不在 Gate A 预建"，017 是 Gate B，时机合规。
- 017 **不强制现有工具响应 signal**；由示例 stub（见 Q7）证明 ctx.signal 机制可用，真实工具在 018 接入时由 handler 自行决定是否接 ctx.signal。

选 (b') 而非 (a) 的理由：模型可中断是 HTTP 协议物理约束（铁定），工具可中断是否必需取决于工具是否长跑；015 接口在 017 实施后更难改，趁 017 写真实 adapter 时把 signal 通道铺到 handler 边界是契约完整，不预建。

### Q2 单次调用超时阈值

**(c) `LoopEngineDeps` 加可选 `timeoutMs: number`，默认 60000**。

- 模型超时：adapter 内 SDK client/fetch 绑超时；超时即失败（由 adapter 决定抛错或形成失败结果）。
- 工具执行超时：Executor 给单次 `def.handler(input, ctx)` 包超时（Promise.race 风格强制超时，不依赖 handler 内部支持）；超时即 `execution_failed`。
- **不引入自动重试**：自动重试需"什么错可重试、退避曲线、幂等键"等真实失败证据，015 已冻"Executor 不自动重试"，017 不动 015。
- 具体阈值由 018 调用方在 deps 传，默认 60s 仅兜底；018 真实接通后用真实失败回流收紧。

### Q3 诊断回流形态

**(b) 独立 LoopTrace 第二返回面**：run() 返 `{ result: RunResult, trace: LoopTrace }`。

- trace 是非权威收据，与 014"messages 唯一权威"严格解耦；`RunResult` 保持只承载"最终结果"语义，不被诊断字段污染。
- 选 (b) 而非 (a) RunResult 加 diagnostics 的理由：一次决策覆盖 017 to-refine 第 1 项（物理必需诊断）和第 4 项（最小 trace），避免 016 哲学"判别联合 + 值类型"被 RunResult 字段膨胀破坏。
- 选 (b) 的代价（016 哲学偏离"判别联合"多了第二个返回对象）通过 trace 边界严格守 014 平衡。

### Q4 取消/超时触发后的停止语义与在途收尾

**StopReason 扩展两类**：`cancelled`（signal abort 触发）+ `timeout`（timeoutMs 触发）。七类 StopReason：

- `completed` / `maxTurns` / `nonSuccessStop` / `protocolError` / `emptyFinalResponse`（016 已冻五类）
- `cancelled`（新增） / `timeout`（新增）

依据 016 Q1 已预留的"判别联合向后兼容扩展（加 kind 不破坏老调用方）"，不重开 016。

**在途收尾规则**：

- **模型在途被 abort/超时**：assistant 回合还没完整返回，014 原子校验没过 -> 整回合不进历史（与 protocolError 一致）。`stop reason: cancelled | timeout`，`finalState` = 中断前 state（不含半成品回合）。
- **工具在途被 abort/超时**：assistant 回合已原子追加进历史，被中断 tool call 填 `execution_failed`（message 标 "timeout" 或 "cancelled"）tool_result 进历史，再 stop。**这是 015 悬空调用禁止下的唯一合规解**（不允许回滚 014 已追加的 assistant 回合，不允许悬空 tool_use）。

### Q5 LoopTrace 最小字段集 + 聚合方式

**trace 字段最小集（A 层，017 必须记）**：

每回合 `TurnTrace`：

- `turnIndex: number`
- `supplierStop: "success" | "truncation" | "refusal" | "other"`（从 AssistantTurnResult.supplierStop 取，零成本）
- `toolCalls: ReadonlyArray<{ toolUseId, toolName, kind: "ok" | "validation_failed" | "tool_not_found" | "execution_failed", message?: string }>`（**不含 payload**——payload 在 messages 权威保存，trace 重复违反 014 边界）
- `durationMs: number`（该回合 wall-clock）
- `timeoutHit: boolean`（该回合是否触发超时）
- `signalAborted: boolean`（该回合是否被 signal 中断）

全局 `Totals`：

- `totalDurationMs: number`
- `timeoutHits: number`（累计）
- `signalAborteds: number`（累计）
- `toolErrorTotals: { ok, validation_failed, tool_not_found, execution_failed }`（累计）

**B 层字段（推迟到 018 真实接通后决定）**：`tokenUsage` / `costUsd` / `model` 标识 / `httpStatus` / `requestId`——017 离线替身下无真实数据，预建违反"最小"，018 接真实 SDK 后按真实回流决定。

**聚合方式**：`signal` 与 `timeoutMs` 进 `LoopEngineDeps`（与 `maxTurns` 同位置；016 Q2 "deps 是参数集合、随步传入、immutable" 哲学一致）；`step()` 内 `performance.now()` 计时 + 观测 supplierStop/toolResults/timeoutHit/signalAborted；`run()` 内 immutable 累积 `TurnTrace[]`，返 `{result, trace}`。不引入 collector 回调（避免可变状态；016 Q2 哲学）。

### Q6 物理必需层 vs 条件式修复层（对仗边界）

| 物理必需层（本票实施）                                        | 条件式修复层（推迟为 017 out-of-scope）                         |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| signal 透传到 adapter+Executor，ToolHandler 加可选 ctx.signal | 工具 handler 是否响应 signal（018 接真实工具时由 handler 决定） |
| timeoutMs 可配置默认 60000                                    | 工具按 handler 类型细分超时阈值                                 |
| 单次调用超时（模型+工具）                                     | 自动重试策略（次数/退避/幂等/可重试错误分类）                   |
| StopReason 七类（加 cancelled+timeout）                       | 可重试/不可重试错误分类细化                                     |
| 在途收尾（execution_failed tool_result 标 timeout/cancelled） | 续写/自动重试/fallback                                          |
| LoopTrace A 层最小集                                          | trace B 层（tokenUsage/cost/model/httpStatus/requestId）        |
| trace 报 timeoutHit/signalAborted                             | token/cost 护栏 + threshold manifest                            |
| maxTurns 唯一回合护栏；总耗时作为 trace 诊断项                | 总耗时作为独立 stop 触发器                                      |
| --                                                            | 结构化 trace 完整生产形态（OTel/metrics/span 树）               |

**017 实施时严格守左列**；右列任何一项进入 017 实施范围都视为违反 Fixed boundary "不预建完整权限平台、后台任务、自动压缩或生产级 tracing"。

### Q7 目标文件 / 验证场景 / 完成证据

**目标文件**（在 016 已有 `src/harness/` 结构上扩展，零新根；延续 016 Q6 不碰旧 `src/agent-loop/`）：

| 能力                                  | 落点                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| signal 透传 + ctx.signal              | `tools/types.ts`（ToolHandler 加可选 ctx）、`tools/executor.ts`（透传 signal）、`model-adapter/types.ts`（ModelAdapter.step 加 signal 参）、`loop-engine.ts`（step/run 加 signal） |
| timeoutMs + 单次超时                  | `loop-engine.ts`（deps 加 timeoutMs）、`model-adapter/anthropic-adapter.ts`（绑 SDK 超时）、`tools/executor.ts`（handler 包 Promise.race 超时）                                    |
| StopReason 七类                       | `model-adapter/types.ts`（加 cancelled/timeout）、`loop-engine.ts`（在途收尾分支）                                                                                                 |
| LoopTrace                             | 新增 `loop-trace.ts`（类型 + 聚合）、`loop-engine.ts`（step 内 timing + run 内累积 + 返 `{result, trace}`）                                                                        |
| 示例 stub（证明 ctx.signal 机制可用） | `stubs/`（加一个响应 signal 的 stub tool）                                                                                                                                         |

**验证场景**（新增 fixture S12–S17，全离线替身可验证，不需要真实模型/工具/网络）：

- **S12 signal abort 在模型在途**：run 启动后 abort signal -> stop `cancelled`，整回合不进历史，trace.turns 末项 `signalAborted=true`。
- **S13 signal abort 在工具在途**：assistant 回合已进历史，工具执行中被 abort -> 被中断 tool call 填 `execution_failed`（message 标 "cancelled"）tool_result 进历史，stop `cancelled`，trace.turns 末项 `signalAborted=true` + 该 toolCall `kind="execution_failed"`。
- **S14 timeout 触发（模型在途）**：stub model 延迟 > timeoutMs -> stop `timeout`，整回合不进历史，trace.turns 末项 `timeoutHit=true`。
- **S15 timeout 触发（工具在途）**：stub tool 延迟 > timeoutMs -> 被中断 tool call 填 `execution_failed`（message 标 "timeout"）tool_result 进历史，stop `timeout`，trace.turns 末项 `timeoutHit=true`。
- **S16 LoopTrace 完整性**：多回合 run 后 trace.turns.length == turnCount；每回合字段齐全；totals 聚合正确（timeoutHits/signalAborteds/toolErrorTotals）；**trace 不含 payload**（守 014 边界）。
- **S17 ctx.signal 机制可用**：示例 stub tool 接 ctx.signal，abort 后该 handler 抛 AbortError -> Executor 转 `execution_failed`。证明 015 ToolHandler 扩展的机制可用，不依赖真实工具。

**完成证据**：

1. 新增 S12–S17 全过 + 016 原有 S1–S11 + Adapter 7 类 + Registry 构造验收全过**不回归**。
2. `npm run typecheck` 通过。
3. 完整 `npm test` 通过（212 现有测试 + 新增不回归）。
4. **显式守门**：S16 / S17 通过（trace 不含 payload + ctx.signal 机制可用）。
5. **显式守门**：代码审查确认 `src/harness/` **不含条件式修复层**（无自动重试、无 token/cost 护栏、无 trace B 层字段、无工具分类超时、无总耗时独立 stop、无 OTel/metrics/span 树）--严守 Q6 对仗边界。
6. 015 ToolHandler 扩展 / ModelAdapter.step 扩展 / StopReason 扩展均属"判别联合 + 可选字段向后兼容"方式（016 Q1 已授权），不重开 014/015/016。

## Exit condition

物理必需层五件套（取消 b' / 超时 c / 诊断 b / 停止语义七类 + 在途收尾 / trace A 层最小集）已实现且有 S12–S17 离线替身验收，S16 / S17 显式守门通过，代码审查确认不含条件式修复层，`npm run typecheck` 与完整 `npm test` 通过，016 既有验收不回归；足以安全进入 018。

条件式修复层（自动重试 / token/cost 护栏 / trace B 层字段 / 工具按 handler 类型细分超时 / 错误分类细化 / 总耗时独立 stop / 生产级 tracing 平台）作为 017 out-of-scope 推迟到 018 真实接通暴露失败后按 013"条件式修复"原则开后续票补。

本票关闭代表决策细化完成，不代表代码或产品路径已实施。
