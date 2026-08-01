# Spec: Loop Hardening for Migration (017 Gate B — 物理必需层)

> **Lean spec.** 017 ticket 的 Q1–Q7 Resolution 是本 spec 的权威先决决议；本 spec 只补充 Resolution 未钉死的实施层细节（类型签名、参数位置、判定顺序、聚合时机、ACR gate）。未在本 spec 重述的内容，以 017 Resolution + 014/015/016 冻结契约为准。

## Assumptions (confirmed)

> 以下 14 条假设经人工逐条确认（2026-07-28），构成本 spec 的实施层决策基础。
> wayfinder 017 Q1–Q7 Resolution 作为先决决议直接引入，不在本 list 重开。

1. **A1 返回形状**：`run()` 返回 `{ result: RunResult; trace: LoopTrace }`（对象字面量，非元组）。RunResult 保持 016 形状零变更（finalText / messages / turnCount / stopReason）。(a) RunResult 加 diagnostics 方案显式弃用。
2. **A2 deps 扩展 + signal 位置**：`LoopEngineDeps` 加可选 `timeoutMs?: number`（运行时兜底 60000，不在类型层写死默认值）。`run(userText, deps, signal?)` / `step(state, deps, signal?)`：signal 为第 3 位置参数，不进 deps。不引入 Collector 回调 / trace 中途观察点；trace 完全在 run 内部 immutable 累积。
3. **A3 超时字段**：`timeoutMs` 主字段 + `modelTimeoutMs?` / `toolTimeoutMs?` 可选覆盖。生效优先级：`modelTimeoutMs ?? timeoutMs ?? 60000`（模型侧）、`toolTimeoutMs ?? timeoutMs ?? 60000`（工具侧）。模型侧 adapter 内部绑超时；工具侧 Executor `Promise.race` 强制超时，不依赖 handler 内部支持。Loop Engine 自身不做超时计时。
4. **A4 ToolHandler ctx**：`ToolHandler = (input: unknown, ctx?: ToolExecutionContext) => ...`。`ToolExecutionContext = { readonly signal?: AbortSignal }`，仅含 signal，不含 timeoutMs。ctx 整体可选（015 老 handler 签名 `(input) => ...` 继续合法）。signal 为 run 第三参原样透传，不创建子 signal。017 不强制现有工具响应 ctx.signal。
5. **A5 StopReason 扩展**：在 016 五类末尾追加 `"cancelled" | "timeout"`，共七类。不重排既有五类。Transition 判别联合形状零变更（reason 字段类型随 StopReason 自动扩展）。触发判定：cancelled 由 Loop Engine 检测 `signal.aborted`；timeout 由 adapter/executor 返回超时结果后 Loop Engine 据此判定。
6. **A6 在途收尾**：模型在途 → finalState = step 入口时 state（turnCount/messages 不变），整回合不进历史，stop cancelled/timeout。工具在途 → assistant 回合已原子追加（不可回滚）；同回合 N 个 tool call：已完成正常填，在途填 `execution_failed`（message 固定标 "cancelled" 或 "timeout"，不可配置）；所有 tool_result 编码为一条 user message 原子追加后 stop。不存在回滚/悬空分支。判定顺序：signal 优先 → 模型阶段先于工具阶段。
7. **A7 LoopTrace 字段集**：顶层 `{ turns: ReadonlyArray<TurnTrace>; totals: Totals }`。TurnTrace：turnIndex / supplierStop（引用 014 值域）/ toolCalls（kind 引用 015 值域，不含 payload）/ durationMs（step 入口→出口 wall-clock）/ cancelKind（"none" | "callerAbort" | "timerTimeout" | "hostCancel"，值域对齐 023 RaceModelOutcome.source）。Totals：totalDurationMs / cancelKindCounts（{ none / callerAbort / timerTimeout / hostCancel }）/ toolErrorTotals。聚合时机：run 结束时一次性 reduce（非增量累加）。B 层字段（tokenUsage / costUsd / model / httpStatus / requestId）017 不实现。

> 025 #98 解冻：A7 TurnTrace 双布尔（timeoutHit/signalAborted）重构为单一枚举 cancelKind，Totals 同步为 cancelKindCounts。操作员显式授权；行为零变更（loop 控制流/StopReason 不动），trace 获得 hostCancel 分辨力（与 023 #54 RaceModelOutcome.source 对齐）。

8. **A8 对仗边界**：Q6 右列 7 项写入 Boundaries-Never。任何右列项进 017 实施 = 违反 Fixed boundary。
9. **A9 示例 stub**：`src/harness/stubs/` 新增响应 ctx.signal 的示例 stub tool（abort → AbortError → Executor 转 execution_failed）。stub-model 扩展：可注入延迟 + 可绑 signal。stubs 不进生产装配路径。
10. **A10 验证场景归属**：S12–S17 写在 `tests/harness/` 下（续 loop-engine.test.ts 或新建 loop-hardening.test.ts，writing-plans 微调）。全离线替身可验。016 S1–S11 + Adapter 7 类 + Registry 构造验收不回归。
11. **A11 测试层**：全 unit（替身 + signal/timeout 注入）。不引入 e2e / 不接产品流量 / 不引入新测试框架。
12. **A12 执行边界**：完全不碰 `src/agent-loop/`。不接产品流量。不启动 Session HTTP / chat REPL。
13. **A13 ADR**：`docs/adr/` 当前为空，无 in-scope ADR。决策契约来源 = 014/015 ticket + 016 Resolution + 017 Resolution。
14. **A14 产物**：路径 `specs/loop-hardening-for-migration.md`。不与 plans/ 合并。本 spec 是 016 spec 的层续，不替代、不修改 016 spec。

## Objective

**What**: 实现 Foundation 的 Gate B 物理必需层 — 在 016 Gate A 最小顺序闭环基础上，加入取消（signal 透传）、超时（timeoutMs 单次强制）、诊断回流（独立 LoopTrace 第二返回面）、停止语义扩展（StopReason 七类 + 在途收尾）、最小 trace（A 层字段集）。

**Why**: 017 在替身闭环下证据真空（Gate A 是离线脚本实现、新内核完全没接产品流量）。物理必需层五件套的证据是"任何 HTTP agent loop 迁移的物理必需"或"调用方迁移必需"，不需要等真实失败就能确定。条件式修复层（自动重试 / token-cost 护栏 / trace B 层 / 工具分类超时 / 错误分类细化 / 总耗时独立 stop / 生产级 tracing 平台）推迟到 018 真实接通后按 013 条件式修复原则补。

**Who**: 实施者（本 spec 的下游 `writing-plans` 消费者）。Gate B 用替身 model / 替身 tool + signal/timeout 注入验证，**不接产品流量**。

**Success**: S12–S17 fixture 全过 + 016 S1–S11 + Adapter 7 类 + Registry 构造验收不回归；S16（trace 不含 payload）/ S17（ctx.signal 机制可用）显式守门通过；代码审查确认不含条件式修复层。

> 详见 017 Resolution Q1–Q7 与 Exit condition。

## Tech Stack

继承 016 spec Tech Stack，零新增依赖：

- **Language**: TypeScript（ES2022 / NodeNext / strict / noUnusedLocals / verbatimModuleSyntax / isolatedModules）。
- **Module**: ESM（`"type": "module"`）；TS 源码内部相对导入用 `.js` 后缀。
- **Model SDK**: `@anthropic-ai/sdk`（016 A1 决策）。Adapter 内部绑 signal + timeout 到 SDK client/fetch。
- **JSON Schema validator**: `ajv@^8.17.1` + `ajv-formats@^2.1.1`（016 A2 决策），`strict: true`。
- **Test runner**: Node 内建 test runner via `tsx --test tests/**/*.test.ts`（016 A4 决策）。不引入 Jest/Vitest。
- **Runtime**: Node 服务端。`AbortController` / `AbortSignal` / `performance.now()` 均为 Node 内建，不引入 polyfill。

> Tech stack 变更需新假设门（spec-driven-development Iron Law）。017 不新增任何 runtime / dev 依赖。

## Commands

```bash
# Type check
npm run typecheck

# Full test suite (Node built-in runner via tsx)
npm test
```

> 命令继承项目 `package.json` scripts，017 不新增 npm script。

## Project Structure

在 016 已有 `src/harness/` 结构上扩展，零新根目录。延续 016 Q6 不碰旧 `src/agent-loop/`。

```
src/harness/
├── index.ts                  # 公共出口（扩展：导出 LoopTrace 类型）
├── errors.ts                 # Foundation 自治错误类（016 已有，017 不新增错误类）
├── loop-engine.ts            # Loop Engine（扩展：deps 加超时字段、step/run 加 signal、
│                             #   step 内 timing + 在途收尾分支、run 内 trace 累积 + 返 {result, trace}）
├── loop-trace.ts             # 【新增】LoopTrace / TurnTrace / Totals 类型 + 聚合函数
├── model-adapter/
│   ├── anthropic-adapter.ts  # Anthropic Adapter（扩展：step 加 signal 参、绑 SDK 超时）
│   └── types.ts              # ModelAdapter 接口（扩展：step 加 signal 参）、
│                             #   StopReason（扩展：加 cancelled / timeout）
├── tools/
│   ├── registry.ts           # Registry（016 已有，017 不动）
│   ├── executor.ts           # Executor（扩展：executeAll 加 signal 参、
│   │                         #   handler 包 Promise.race 超时、透传 ctx）
│   ├── tool-result.ts        # ToolExecutionResult（016 已有，017 不动）
│   └── types.ts              # ToolDef 等（扩展：ToolHandler 加可选 ctx 参、
│                             #   新增 ToolExecutionContext 类型）
└── stubs/
    ├── stub-model.ts         # 替身 model（扩展：可注入延迟 + 可绑 signal）
    ├── stub-tool.ts          # 替身 tool（016 已有，017 不动）
    └── stub-signal-tool.ts   # 【新增】示例 stub：响应 ctx.signal（S17 守门）

tests/harness/
├── loop-engine.test.ts       # 016 S1–S11（不动）+ 017 S12–S17（续段或新文件，writing-plans 微调）
├── model-adapter/
│   └── anthropic-adapter.test.ts  # 014 的 7 类离线验收（不动）
└── tools/
    └── registry.test.ts      # 015 Registry 构造验收（不动）
```

> 文件名 / 子模块拆分是实施细节；writing-plans 可微调，但职责切分（Loop Engine / Model Adapter / tools / stubs / loop-trace）不得变。新增文件仅 `loop-trace.ts` + `stubs/stub-signal-tool.ts`，零新根目录。

## Code Style

### TS 类型签名（017 扩展，在 016 已冻形状上增量）

```ts
// src/harness/model-adapter/types.ts — StopReason 扩展（A5）

/** 017 Q4 七类停止原因（016 五类 + 新增两类，末尾追加不重排）。 */
export type StopReason =
  | "completed" // 016：成功停止
  | "maxTurns" // 016：到达上限
  | "nonSuccessStop" // 016：截断/拒绝
  | "protocolError" // 016：协议结构错误
  | "emptyFinalResponse" // 016：空最终响应
  | "cancelled" // 017 新增：signal abort 触发
  | "timeout"; // 017 新增：timeoutMs 触发

// Transition 判别联合形状零变更（reason 字段类型随 StopReason 自动扩展）。

/** ModelAdapter.step 扩展：加 signal 参（Q1）。 */
export interface ModelAdapter {
  step(
    state: LoopState,
    deps: LoopEngineDeps,
    signal?: AbortSignal // 017 新增
  ): Promise<Transition>;
}
```

```ts
// src/harness/loop-engine.ts — deps 扩展 + 入口签名（A2, A3）

/** Loop Engine 依赖（017 扩展：加超时字段）。 */
export interface LoopEngineDeps {
  readonly adapter: ModelAdapter;
  readonly executor: Executor;
  readonly registry: Registry;
  readonly maxTurns: number;
  readonly timeoutMs?: number; // 017 新增：主超时，默认兜底 60000
  readonly modelTimeoutMs?: number; // 017 新增：模型侧覆盖
  readonly toolTimeoutMs?: number; // 017 新增：工具侧覆盖
}
// 生效优先级：modelTimeoutMs ?? timeoutMs ?? 60000（模型侧）
//             toolTimeoutMs  ?? timeoutMs ?? 60000（工具侧）

/** 单步状态机推进（017 扩展：加 signal 参）。 */
export function step(
  state: LoopState,
  deps: LoopEngineDeps,
  signal?: AbortSignal // 017 新增
): Transition;

/** 整轮运行（017 扩展：加 signal 参 + 返回 {result, trace}）。 */
export function run(
  userText: string,
  deps: LoopEngineDeps,
  signal?: AbortSignal // 017 新增
): Promise<{ result: RunResult; trace: LoopTrace }>;
// RunResult 保持 016 形状零变更（finalText / messages / turnCount / stopReason）。
```

```ts
// src/harness/tools/types.ts — ToolHandler 扩展（A4）

/** 017 新增：工具执行上下文。 */
export interface ToolExecutionContext {
  readonly signal?: AbortSignal; // run 第三参原样透传，不创建子 signal
}

/** 015 ToolHandler 扩展：加可选 ctx 参（015 老签名 (input) => ... 继续合法）。 */
export type ToolHandler = (
  input: unknown,
  ctx?: ToolExecutionContext // 017 新增
) => ToolExecutionResult | Promise<ToolExecutionResult>;
```

```ts
// src/harness/loop-trace.ts — 【新增】LoopTrace 类型 + 聚合（A7）

/** 每回合诊断（A 层，Q5 字面）。 */
export interface TurnTrace {
  readonly turnIndex: number;
  readonly supplierStop: "success" | "truncation" | "refusal" | "other";
  // 引用 014 AssistantTurnResult.supplierStop 值域，不新定义
  readonly toolCalls: ReadonlyArray<{
    readonly toolUseId: string;
    readonly toolName: string;
    readonly kind:
      "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
    // 引用 015 ToolExecutionResult.kind 值域，不新定义
    readonly message?: string;
  }>;
  // 严格不含 input / output / payload（014 边界守门，S16 显式验证）
  readonly durationMs: number; // step 入口 → 出口 wall-clock
  // #98：替换 017 双布尔 timeoutHit/signalAborted 为单一枚举；行为零变更，
  // trace 获得 hostCancel 分辨力（与 023 #54 RaceModelOutcome.source 对齐）。
  readonly cancelKind: "none" | "callerAbort" | "timerTimeout" | "hostCancel";
}

/** 全局聚合（A 层，Q5 字面）。 */
export interface Totals {
  readonly totalDurationMs: number;
  // #98：替换 017 双布尔聚合 timeoutHits/signalAborteds 为枚举计数对象。
  readonly cancelKindCounts: {
    readonly none: number;
    readonly callerAbort: number;
    readonly timerTimeout: number;
    readonly hostCancel: number;
  };
  readonly toolErrorTotals: {
    readonly ok: number;
    readonly validation_failed: number;
    readonly tool_not_found: number;
    readonly execution_failed: number;
  };
}

/** 一次 run 的完整诊断（独立第二返回面，与 014 messages 唯一权威严格解耦）。 */
export interface LoopTrace {
  readonly turns: ReadonlyArray<TurnTrace>;
  readonly totals: Totals;
}

/** 聚合：run 结束时一次性从 turns reduce（纯函数，非增量累加）。 */
export function computeTotals(turns: ReadonlyArray<TurnTrace>): Totals;
```

### 风格要点

继承 016 风格要点，新增：

- **Immutable trace 累积**：`turns` 更新用 `[...prevTurns, newTurn]`，禁止 push / 原地修改（与 messages append-only 同模式）。
- **不引入 Collector 回调**：trace 只在 run 内部 immutable 累积，一次性随 `{ result, trace }` 返回。不开 `onTurn(cb)` / `onTrace(cb)` 等中途观察点（A2 确认，护 016 Q2 纯 B 哲学）。
- **trace 不含 payload**：toolCalls 只记 kind + message，不记 input / output（014 边界：payload 在 messages 权威保存，trace 重复违反边界）。
- **超时强制不依赖 handler**：Executor 用 `Promise.race` 外包超时，handler 内部无需感知（Q2 "不依赖 handler 内部支持"）。
- **signal 原样透传**：run 第三参 signal 同一个对象传到 adapter + executor + ctx.signal，不创建子 signal、不在 signal 层合并超时（cancelled 和 timeout 是两条独立路径）。

> 命名 / 格式细节沿用项目既有 TS 风格；writing-plans 可补具体 lint 规则。

## Testing Strategy

继承 016 测试层 + 017 Q7 新增 S12–S17：

- **016 既有（不回归）**：
  - Loop Engine fixture 矩阵 S1–S11 — `tests/harness/loop-engine.test.ts`。
  - Adapter 离线验收 7 类（含流中断）— `tests/harness/model-adapter/anthropic-adapter.test.ts`。
  - Registry 构造验收 — `tests/harness/tools/registry.test.ts`。

- **017 新增 S12–S17**（全离线替身可验证，不需要真实模型/工具/网络）：
  - **S12 signal abort 在模型在途**：run 启动后 abort signal → stop `cancelled`，整回合不进历史，trace.turns 末项 `cancelKind="callerAbort"`。
  - **S13 signal abort 在工具在途**：assistant 回合已进历史，工具执行中被 abort → 被中断 tool call 填 `execution_failed`（message 标 "cancelled"）tool_result 进历史，stop `cancelled`，trace.turns 末项 `cancelKind="callerAbort"` + 该 toolCall `kind="execution_failed"`。
  - **S14 timeout 触发（模型在途）**：stub model 延迟 > timeoutMs → stop `timeout`，整回合不进历史，trace.turns 末项 `cancelKind="timerTimeout"`。
  - **S15 timeout 触发（工具在途）**：stub tool 延迟 > timeoutMs → 被中断 tool call 填 `execution_failed`（message 标 "timeout"）tool_result 进历史，stop `timeout`，trace.turns 末项 `cancelKind="timerTimeout"`。
  - **S16 LoopTrace 完整性**：多回合 run 后 trace.turns.length == turnCount；每回合字段齐全；totals 聚合正确（cancelKindCounts / toolErrorTotals）；**trace 不含 payload**（守 014 边界）。
  - **S17 ctx.signal 机制可用**：示例 stub tool 接 ctx.signal，abort 后该 handler 抛 AbortError → Executor 转 `execution_failed`。证明 015 ToolHandler 扩展的机制可用，不依赖真实工具。

- **测试层**：全 unit（替身 model / 替身 tool + signal/timeout 注入，无真实模型/网络/产品流量）。
- **测试框架**：Node 内建 test runner via `tsx --test`（继承 016，不引入新框架）。

> Success Criteria 区把每条转成二元判据。

## Boundaries

- **Always do**:
  - 跑 `npm run typecheck` + `npm test` 全绿后才算完成。
  - 严格校验（ajv `strict: true`）：不做隐式类型转换、不裁剪未知字段、不猜测缺失值（继承 015/016）。
  - 同回路多 tool call 串行、无短路、无自动重试（继承 015/016）。
  - append-only `messages`：immutable 追加，不原地修改（继承 014/016）。
  - trace immutable 累积：`[...prevTurns, newTurn]`，不 push / 不原地修改。
  - trace 不含 payload：toolCalls 只记 kind + message（守 014 边界）。
  - 超时强制由 Executor Promise.race 外包，不依赖 handler 内部支持。
  - signal 原样透传，不创建子 signal。

- **Ask first**:
  - 新增 runtime 依赖（017 不新增任何依赖）。
  - 修改 `tsconfig.json` 或 `package.json` scripts。
  - 调整 `src/harness/` 子模块职责切分。
  - 修改 016 已冻类型形状（LoopState / Transition / RunResult）。

- **Never do**:
  - 碰旧 `src/agent-loop/`（不 import / 不改 / 不复用类型）— 继承 016 Q6。
  - 接入真实 `kb_*` 工具或产品流量 — 018 范围。
  - 引入 Collector 回调 / trace 中途观察点（`onTurn(cb)` / `onTrace(cb)` 等）— A2 确认。
  - **条件式修复层（Q6 右列，017 严格禁止）**：
    - 自动重试策略（次数 / 退避 / 幂等 / 可重试错误分类）
    - token / cost 护栏 + threshold manifest
    - trace B 层字段（tokenUsage / costUsd / model / httpStatus / requestId）
    - 工具按 handler 类型细分超时阈值
    - 可重试 / 不可重试错误分类细化
    - 总耗时作为独立 stop 触发器
    - 结构化 trace 完整生产形态（OTel / metrics / span 树）
  - 删除测试让构建通过；把失败测试改成跳过 — 项目 code-quality.md。
  - 重开 014/015/016 已冻契约（017 扩展均为判别联合 + 可选字段向后兼容方式）。

## Success Criteria

二元判据（每条 yes/no）：

1. `npm run typecheck` 退出码 0？□
2. `npm test` 退出码 0？□
3. S12 signal abort 模型在途：stop `cancelled` + 整回合不进历史 + trace 末项 `cancelKind="callerAbort"`？□
4. S13 signal abort 工具在途：被中断 tool call 填 `execution_failed`（message "cancelled"）进历史 + stop `cancelled` + trace 末项 `cancelKind="callerAbort"`？□
5. S14 timeout 模型在途：stop `timeout` + 整回合不进历史 + trace 末项 `cancelKind="timerTimeout"`？□
6. S15 timeout 工具在途：被中断 tool call 填 `execution_failed`（message "timeout"）进历史 + stop `timeout` + trace 末项 `cancelKind="timerTimeout"`？□
7. S16 LoopTrace 完整性：trace.turns.length == turnCount + 每回合字段齐全 + totals 聚合正确 + **trace 不含 payload**？□
8. S17 ctx.signal 机制可用：示例 stub 接 ctx.signal → abort → AbortError → Executor 转 `execution_failed`？□
9. 016 S1–S11 全过不回归？□
10. Adapter 7 类离线验收全过不回归？□
11. Registry 构造验收全过不回归？□
12. 代码审查确认 `src/harness/` 不含条件式修复层（无自动重试 / 无 token-cost 护栏 / 无 trace B 层字段 / 无工具分类超时 / 无总耗时独立 stop / 无 OTel-metrics-span 树）？□
13. 015 ToolHandler 扩展 / ModelAdapter.step 扩展 / StopReason 扩展均属"判别联合 + 可选字段向后兼容"方式，不重开 014/015/016？□

> 判据 7（trace 不含 payload）和判据 8（ctx.signal 机制可用）是 017 Exit condition 的两条**显式守门**。
> 判据 12 是"没有把条件式修复层提前带入内核"的显式守门。

## Open Questions

无。017 Q1–Q7 Resolution + 本 spec A1–A14 假设已覆盖全部实施层决策点。剩余文件名 / lint 规则 / S12–S17 具体 test 文件归属（续段 vs 新文件）属 writing-plans 范围，不阻塞 spec。

---

## Architectural Constraints

- **无 in-scope ADR**：`docs/adr/` 当前为空。决策契约来源 = 014 ticket（模型回合与历史契约）+ 015 ticket（工具 ACI 与结果边界）+ 016 Resolution Q1–Q6（最小顺序 Agent Loop）+ 017 Resolution Q1–Q7（Loop 必要加固）。
- **领域语言**（引自 `docs/CONTEXT.md`，不重定义）：
  - **Loop Engine**：Foundation 的状态机运行内核，位于 `src/harness/`。
  - **append-only messages**：Foundation 的权威 Anthropic 原生会话历史，唯一事实来源。
  - **turnCount**：Foundation 运行时回合计数，每完成一个 assistant 回合加一。
  - **stub model / stub tool**：确定性测试替身，覆盖真实模型或工具交通之外的行为。
- **消歧**（引自 `docs/CONTEXT.md` Flagged ambiguities）：
  - **turnCount vs max_hops**：`turnCount`（Foundation）统计每个已完成的 assistant 回合；`max_hops`（产品 / eval）只统计 retrieve + verify hop（默认 5）；两者属于不同层次，不得混同。

---

## ACR 5-Verdict Gate

> `architecture-change-reviewer` 已跑（2026-07-28，spec 同步会话）。5 维全绿。

1. **bounded-context-guardian**: `yes` — 变更限于 `src/harness/{loop-engine,model-adapter,tools,stubs,errors,index}` + 新增 `loop-trace.ts` 和 `stubs/stub-signal-tool.ts`；零跨切 `src/agent-loop` / `src/cli` / `src/session-api` / `src/interaction` / `src/eval`；扩展为已有能力模块的增量（ModelAdapter.step +signal、LoopEngineDeps +timeouts、ToolHandler +ctx），能力切分不变，无技术层命名。
2. **defensive-contract-validator**: `yes` — S12–S17 覆盖 5 类边界：empty（S16 空 turns 时 totals 全零）、negative（S13/S15 工具失败路径 execution_failed）、overflow（S14/S15 超时 = 时间溢出）、exception（S12/S13 外部 AbortSignal 中断）、concurrent 正确 N/A（单线程顺序 step，015 冻串行 Executor）。stubs 提供离线验证 harness，不依赖真实基础设施。
3. **error-handling-enforcer**: `yes` — 017 不新增错误类（复用 016 errors.ts 三类）；超时 / 取消通过 StopReason 判别联合 + ToolExecutionResult.kind="execution_failed" 结构化结果表达，不抛裸异常到主控流；在途收尾分支（A6）显式列出判定顺序（signal > 模型 > 工具），无 empty catch；(a) RunResult 加 diagnostics 方案显式弃用（A1）。
4. **complexity-anti-drift**: `yes` — 纯函数设计延续（step/run immutable state thread-through）；LoopEngineDeps 4→7 字段（3 个可选超时，不增构造复杂度）；step()/run() 各加 1 个可选第 3 参 signal；loop-trace.ts 单一职责（类型 + computeTotals 纯 reduce，nesting ≤ 2）；stub-signal-tool.ts 单一 ToolDef 工厂。
5. **minimal-change-verifier**: `yes` — scope 严格限于 `src/harness/**` + `tests/harness/**`；新增文件仅 2 个；Boundaries-Never 显式禁止碰旧 `src/agent-loop/`、Collector 回调、B 层 trace 字段、重试策略、token/cost 护栏、结构化 tracing、删测试过构建；单 logical task 单 commit；无 package.json / tsconfig 变更。

**OVERALL: PASS** — 5 维全绿，hand to writing-plans。

> **ACR 观察（非阻塞，移交 writing-plans）**：017 ticket 的 Q1–Q7 Resolution 当前仅存在于 PR #27（DRAFT，未合并）。本 spec 的 Assumptions 段（A1–A14）已将 Q1–Q7 全部实施层决策折叠为自包含条文，spec 可独立阅读。但 writing-plans 启动前应确认 PR #27 已合并（Q1–Q7 Resolution 进入 `.wayfinder/issues/017-loop-hardening-for-migration.md`），否则 spec Cross-references 指向的 ticket 文件缺少 Resolution 内容。

---

## Cross-references

- 017 Resolution（Q1–Q7）: `.wayfinder/issues/017-loop-hardening-for-migration.md`
- 016 spec（Gate A）: `specs/minimum-sequential-agent-loop.md`
- 016 Resolution（Q1–Q6）: `.wayfinder/issues/016-minimum-sequential-agent-loop.md`
- 013 Foundation 边界: `.wayfinder/issues/013-agent-loop-foundation-and-migration-boundary.md`
- 014 模型回合契约: `.wayfinder/issues/014-model-turn-and-history-contract.md`
- 015 工具 ACI 契约: `.wayfinder/issues/015-tool-aci-and-result-boundary.md`
- 领域语言: `docs/CONTEXT.md`（Loop Engine / append-only messages / turnCount / stub model+tool / turnCount-vs-max_hops）
- 架构 SSOT: `docs/architecture.md` Capability modules 表（Harness (Foundation) 行）
