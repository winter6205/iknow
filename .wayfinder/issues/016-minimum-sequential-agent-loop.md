---
title: 实现并验证最小顺序 Agent Loop
label: wayfinder:implementation
status: closed
parent: ../maps/agent-loop-foundation.md
assignee: null
blocked_by:
  - 014-model-turn-and-history-contract
  - 015-tool-aci-and-result-boundary
resolution: 2026-07-28 wayfinder work-through
---

## Intent

实现 Foundation Gate A：用冻结的模型回合和工具 ACI 契约跑通“模型 → 工具 → 真实结果 → 下一轮模型 → 明确停止”的最小顺序闭环。

## Fixed boundary

- 权威状态保持最小，不引入记忆、Checkpoint、压缩或第二份语义状态；
- 有有限轮次护栏；
- 使用替身 model 与替身 tool 证明闭环、工具失败和停止行为；
- 不接真实 Company Brain 产品路径，不做 Gate B 加固。

## To refine before implementation

由用户逐项补充（已逐项细化，见下方 Resolution）：

- Loop Engine 与单步 transition 的具体接口；
- 轮次计数语义和停止结果；
- 同回合多个工具调用的执行策略；
- 最小 fixture/验证场景；
- 目标文件、迁移限制与完成证据。

## Resolution（Q1–Q6 细化收口）

### Q1 接口形状

Loop Engine 对外公开 `run()` 与 `step(state, deps) -> Transition`，显式建模为状态机。`State` 是值类型（`messages` + `turnCount`），`Transition` 是判别联合：`{ kind: "continue", nextState }` 或 `{ kind: "stop", reason, finalState }`。判别联合与值类型向后兼容扩展（加 kind / 加可选字段不破坏老调用方）。

### Q2 依赖与状态

Loop Engine 无可变实例状态；`step(state, deps)` 中 deps（`adapter` / `executor` / `registry` / `maxTurns`）随步传入；运行时状态严格线程化、immutable 追加（`[...prev.messages, x]`）。展示形式（class with stateless methods / namespace of functions）留作实施细节。S11（跨 run 不污染）是 Q2 的兑现守门。

### Q3 轮次计数语义与停止结果

`turnCount` 在每次完成一个 assistant 回合（含纯文本完成）后 +1。`maxTurns` 检查在 step 开头（调用前检查）：`state.turnCount >= maxTurns` 时直接返回 `stop`，不再调模型。`StopReason` 五类：

- `completed`（成功停止 + 无 tool call + 至少一段非空文本）
- `maxTurns`（到达上限）
- `nonSuccessStop`（截断 / 拒绝等合法但未完成的供应商结果）
- `protocolError`（assistant 回合协议结构错误，整回合不进入历史）
- `emptyFinalResponse`（供应商报告成功停止但无可展示文本，不进入权威历史）

### Q4 同回合多个工具调用的执行策略

消费 015 已冻契约：串行 / 无短路 / 无自动重试。推论确认两点：

1. 同回合多个 `ToolExecutionResult` 由 Anthropic Adapter 编码为**一条** user message（多 content blocks），Loop **一次原子追加**（Anthropic 协议 + 014 Adapter 所有权）。
2. 含失败工具结果的回合仍算 "continue"（有 tool calls），消耗 `turnCount`，模型下一轮自行修正。

### Q5 最小 fixture / 验证场景

Loop Engine fixture 矩阵 = **S1–S11**：

- **S1 单轮完成** / **S2 单工具调用后完成** / **S3 多工具调用后完成** / **S4 工具失败 -> 修正 -> 完成** / **S5 同回合多调用，部分失败** / **S6 maxTurns 触顶** / **S7 非成功停止** / **S8 空最终响应** / **S9 协议错误回合**：行为验收，对应 014 / 015 已冻停止语义、串行规则、失败回填、协议原子性。
- **S10 append-only 不可变**：结构不变式，守重放性。
- **S11 跨 run 不污染**：结构不变式，守 Q2 纯 B 语义兑现。

职责切分：**Adapter 离线验收**继承 014 的 7 类样例（含流中断），在 `tests/harness/model-adapter/`；**Registry 构造验收**继承 015 范围（在 `tests/harness/tools/`）。两者不进入 Loop Engine fixture 矩阵。**重放性**由 S10 + S11 + 替身 model 确定性共同保证，S1–S9 每条即一次确定性重放，不单列 S14 重放回归。

### Q6 目标文件 / 迁移限制 / 完成证据

- **目标根目录**：`src/harness/` 独立根，含 `loop-engine.ts` / `model-adapter/`（Anthropic Adapter）/ `tools/`（Registry + Executor + ToolExecutionResult）/ `stubs/`（替身，仅供测试）。测试入口 `tests/harness/`，随 Node 内建 test runner（`tsx --test`）执行。文件名 / 子模块拆分是实施细节。
- **迁移限制**：016 实施期间**完全不碰**旧 `src/agent-loop/`（不 import、不改、不复用类型）。旧代码只作行为参考，开发者读但不复用。
- **完成证据**：
  1. Loop fixture 矩阵 S1–S11 + Adapter 7 类离线样例 + Registry 构造验收全过。
  2. `npm run typecheck` 通过。
  3. 完整 `npm test` 通过。
  4. **显式守门**：S10 / S11 通过（append-only 历史可重放）。
  5. **显式守门**：代码审查确认 `src/harness/` 不含 Gate B 能力（重试 / 取消 / 超时 / trace / checkpoint / 并发调度）。

## Exit condition

Gate A 的冻结验收全部通过（S1–S11 + Adapter 7 类 + Registry 构造验收），S10 / S11 显式守门通过，`npm run typecheck` 与完整 `npm test` 通过，append-only 历史可重放（S10 + S11 + 替身确定性），代码审查确认 `src/harness/` 不含 Gate B 或后续 runtime 能力。本票关闭代表决策细化完成，不代表代码或产品路径已实施。

## Resolution comment (2026-07-28)

Gate A 实施已落地并经 work-through 核查，Exit condition 五条逐条满足，本票 close。核查证据如下（三路并行子代理审计，均只读）：

1. **S1–S11 + Adapter 7 类 + Registry 构造验收全过**：`npm test` 24 suites / 212 tests 全绿，含 `tests/harness/loop-engine.test.ts`(15)、`tests/harness/model-adapter/anthropic-adapter.test.ts`(9)、`tests/harness/tools/registry.test.ts`(7)、`tests/harness/tools/executor.test.ts`(9)、`tests/harness/stubs/stub.test.ts`(4)、`tests/harness/skeleton.test.ts`(2)、`tests/harness/public-exports.test.ts`(3)。
2. **S10 / S11 显式守门通过**：append-only 不可变 + 跨 run 不污染，由 `loop-engine.test.ts` 对应用例覆盖。
3. **`npm run typecheck` 通过**：`tsc -p tsconfig.json --noEmit` 退出码 0。
4. **完整 `npm test` 通过**：见第 1 条。
5. **代码审查 `src/harness/` 不含 Gate B 能力**（三路并行审计，VERDICT 均 CLEAN）：
   - **源码审计**：11 个 .ts 文件逐文件读 + 关键词扫描；retry / cancel(AbortController) / timeout(setTimeout/Promise.race) / trace(span/trace_id) / checkpoint(fs/writeFile) / 并发调度(Promise.all) / durable memory / 上下文压缩(compress/summary/prune/budget) 八项均无命中。`executor.ts` 的 `for (const call of calls) { await ... }` 是 spec 允许的串行执行，非并发。
   - **测试审计**：`tests/harness/` 7 个 .test.ts / 51 用例，GATE_B_CASES=0；多工具调用测试验串行顺序（S3/S5），跨 run 测试验消息不泄漏（非 durable memory），stream interruption 验 ProtocolError（非取消信号）。
   - **依赖与边界审计**：`src/harness/` 无 import 指向 `src/agent-loop/` 或 `kb_*`；外部依赖仅 `@anthropic-ai/sdk`(type-only) / `ajv@^8.17.1` / `ajv-formats@^2.1.1`，无 p-retry / p-timeout / pino / 持久化库等 Gate B 性质依赖；反向隔离也 clean（`src/agent-loop/` 与产品路径无 import `src/harness/`，仅 `tests/harness/` 引用）。

**Scope note**：本票验收范围是替身验证可重放（spec 明确"Gate A 用替身 model / 替身 tool 验证，不接产品流量"）。真实模型 live verification 不在 016 验收范围，留待 017 Gate B 细化时作为"Gate A 暴露的真实失败"输入处理——017 现已释放进 frontier。

阻塞释放：017（按迁移需要加固 Loop）进 frontier，018 仍被 017 阻塞。
