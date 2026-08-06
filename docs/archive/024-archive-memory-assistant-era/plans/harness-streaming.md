# Harness 流式支持（stream: true）— 实施计划

**Source**: #147 Resolution（wayfinder:grilling，2026-08-05，9 条裁决 D0–D8；gh-22 skip-spec 直通——Resolution 已含 5 段，操作员显式调 `/arthurpower:writing-plans` 收口，并点头 D0 的 CLAUDE.md 规范变更）。
**Tracker**: GitHub issues（label `ready-for-agent`，native blocking via `addBlockedBy`）。
**设计真值**: #147 Resolution（本计划只分解执行顺序，不重述裁决理由）。实证输入: D7 9router SSE 探针 + SDK 0.115 事件面审计 + host 消费面探测（三子代理，2026-08-05）+ OpenHarness 对照（#147 对照注记）。

## 裁决速览（详见 #147 Resolution）

- **D0**：additive 臂，默认开，env 开关可回退；CLAUDE.md 锁定行须走规范变更（操作员已点头，单独提交）。
- **D1**：SDK `client.messages.stream(params,{signal})`，挂 raceModel composite signal；`finalMessage()` → 现有 `interpretMessage`（零改动）→ `AssistantTurnResult` 同形；事件契约最小集 `text_delta` + `tool_call_start`；原生 SSE 事件不出 adapter 边界。
- **D2**：权威历史只在 turn 边界 append+freeze；partial 是瞬态投影，不进 `LoopState`；请求体逐字节不变，KV 前缀零影响。
- **D3**：`run()` opts 加 `onStream?: (e)=>void` 观察者回调；harness 无缓冲责任；host 断连≠取消；回调吞异常（对齐 `safeTrace`）。
- **D5**：usage 不丢不消费（承载归 #160）。
- **D6**：trace turn 级写不变（ADR-0003 决策 11）；`recordLlmCall` 的 `stream` 布尔按实际模式翻转。
- **D8**：断流不提交半回合（`finalMessage()` reject → raceModel 现有路由）；partial 快照 v1 不消费。

## ACR 5-verdict gate（architecture-change-reviewer，pre-implementation）

首轮裁决（2026-08-05）：bounded-context-guardian **yes** · defensive-contract-validator **no**（缺 empty/overflow/concurrent 三类测试承诺，尤其 raceModel timeout/abort × stream 竞态）· error-handling-enforcer **yes** · complexity-anti-drift **no**（基线超阈：loop-engine.ts 865 行 / stepWithTrace 251 行；T3/T4 无抽函数承诺）· minimal-change-verifier **yes**。

**整改（已并入 T3/T4/T5，下方文本为整改后版本）**：

- T3 补 S2 五边界类的 empty/overflow/concurrent 测试承诺（零事件流、空 delta、超长 delta 累积、streaming truncation、**stream-under-race 竞态专测**）；抽 `stepStreamArm` + `wireStreamEvents` helper，step 主体只做分支路由。
- T4 承诺透传只在 opts 层参数传递、不在 stepWithTrace 内加逻辑行（251 行基线只减不增）。
- T5 修正行号锚点（559,572 → **558,571**，ACR 实测核出漂移）。
- 基线超阈（>300 行文件）记为 tech-debt NOTE，不属本计划整改范围（S5 diff 范围原则）。

**复验（2026-08-05，二轮）：OVERALL PASS — 5/5 yes**。bounded-context-guardian yes · defensive-contract-validator yes（S2 五边界类全覆盖承诺确认，含 stream-under-race 专测）· error-handling-enforcer yes · complexity-anti-drift yes（stepStreamArm/wireStreamEvents 抽离 + stepWithTrace 零新增逻辑行 + 基线超阈按 S5 记 tech-debt 排除）· minimal-change-verifier yes。Gate 通过，hand to execution。

## Context-loop 预检

- `docs/CONTEXT.md`：**发现两处过时词条，随 T7 一并清理**（line 137 "client also sends `stream: false`"；line 191 "SSE trailer vs stream flag … use `parseLlmResponseJson`"——parseLlmResponseJson 已是死代码，全仓仅脚本注释残留）。LoopTrace 严格不含 payload 词条不受影响（D6 不新增 payload 字段）。
- `docs/adr/` 0001–0006：**无矛盾**。ADR-0003（trace turn 级写、Postel's Law）被 D6 直接遵守；017「不重试」冻结保持（OpenHarness 对照注记 3 记录差距，不预建）。流式臂不满足 ADR 三条件中的"surprising w/o context"——已在 #147 grilling 公开裁决，无需另起 ADR。

## Tracer bullets

依赖图：T1 → T2 → T3 → T4 → T5 → T6 → T7（线性主链；T5 标 `[parallel]`——只动 trace 埋点，与 T4 的 opts 透传改动面不相交）。

### 1. T1. `[decision]` env 流式面裁决

- **Affects**: 无代码改动——裁决票，落 Resolution comment。
- **裁决内容**:
  - `IKNOW_LLM_STREAM`：值域 `on | off`，**默认 `on`**（D0）。
  - SSOT 落点：`src/config/env.ts`（对齐 `IKNOW_LLM_THINKING` 先例，新增 `envStreamMode` 或等价 helper）。
  - 非法值行为：回退 `on` 且不崩溃（对齐 thinking flag 先例的回退纪律）。
  - 装配点：`src/cli/runtime.ts` + `src/session-api/hub.ts`（两处 `createRealAnthropicAdapter` 调用传入）。
- **Acceptance**: T1 issue 有 Resolution comment 记录上述四行裁决并 closed。

### 2. T2. `[implementation]` 事件契约 SSOT（`src/harness/stream.ts`）

- **Affects**: 新文件 `src/harness/stream.ts`（`HarnessStreamEvent` 判别联合）、`src/harness/index.ts`（导出）、新测试 `tests/harness/stream.test.ts`。
- **契约形状**（D1 最小集，开放扩展点）:
  ```ts
  export type HarnessStreamEvent =
    | { type: "text_delta"; text: string }
    | { type: "tool_call_start"; name: string };
  ```
  不含 thinking_delta / input_json_delta（留位不发）；SDK 0.115 无 wire 级 ping/error 事件，契约不承诺。
- **Acceptance**: `npm run typecheck` 通过；`grep -n "HarnessStreamEvent" src/harness/stream.ts src/harness/index.ts` 命中；`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 3. T3. `[implementation]` adapter 流式臂（SDK `.stream()` + `finalMessage()`）[blocks: T2]

- **Affects**: `src/harness/model-adapter/anthropic-adapter.ts`（`RealAnthropicAdapterOptions` 加 `stream?: boolean`；`step()` 按开关分两臂）、`src/harness/model-adapter/types.ts`（`step` 的 request 参数加可选 `onStream`）、`tests/harness/model-adapter/anthropic-adapter.test.ts`。
- **实现要点**:
  - stream 臂：`client.messages.stream(params, { signal })`；signal 走 SDK RequestOptions 第二参（直挂 raceModel composite signal，023 语义零改造）。
  - emit：`.on("text", ...)` → `text_delta`；tool_use 的 `content_block_start` → `tool_call_start`；emit 用 try/catch 包裹（吞异常，对齐 `safeTrace`，D3）。
  - 终态：`await stream.finalMessage()` → 现有 `interpretMessage`（零改动，SSOT）→ `AssistantTurnResult` 与非流式臂逐字节同形。
  - 断流（连接中断 / 无 chunk / 静默 EOF）：`finalMessage()` reject → adapter reject，**不构造 AssistantTurnResult**（D8 整回合不提交）。
  - 非流式臂（开关 off 时）：走现有 `client.messages.create`，byte-identical（既有测试不回归）。
  - **测试用 inject 假 stream 对象**（可脚本化事件序列 + 断流 fixture），不依赖真实网络；真实网络验证归 T6 实测。
  - **[ACR complexity 整改] 抽 helper**：stream 臂逻辑抽为模块级 `stepStreamArm(opts, request, signal)`（emit 装配再抽 `wireStreamEvents(stream, onStream)`）；`step` 主体只做 `opts.stream ? stepStreamArm(...) : 现有 create 臂` 的分支路由，保持 ≤ 30 行 / 3 参上限（complexity-anti-drift 硬门）。
- **测试覆盖**（[ACR defensive-contract 整改] S2 五边界类全承诺）:
  - stream 臂正常流：emit 序列 = text_delta×N + tool_call_start；finalMessage → interpretMessage 结果与非流式 fixture 同形（含 usage 字段保留，D5 不丢）。
  - 断流三态：adapter reject（不提交半回合）；partial 快照不被消费。
  - onStream 回调抛异常：被吞咽，不影响 finalMessage 交付。
  - stream=false：现有行为零变化（回归保护）。
  - 空响应（OpenHarness 对照注记 1）：`isEmptyFinalResponse` 语义在流式臂同样命中。
  - **empty 类**：零事件流（直接 message_stop 无 content block）→ `isEmptyFinalResponse` 命中；空 `text_delta`（text=""）→ 不 emit 或 emit 后渲染无副作用（实现期二选一并记录）。
  - **overflow 类**：超长流（数百 delta 累积）→ 累积结果与非流式 fixture 逐字节同形；`max_tokens` 截断（stop_reason=max_tokens）→ `supplierStop="truncation"` 语义与非流式臂一致。
  - **concurrent 类（stream-under-race 专测）**：raceModel 超时/abort 在 streaming 期间触发 → composite signal abort SDK 流 → settle 路由与 023 既有集成测试同语义（timerTimeout → stop "timeout"；callerAbort → stop "cancelled"）；abort 后不再 emit、finalMessage 不被等待（无悬挂 promise）。落点：`tests/harness/model-adapter/anthropic-adapter.test.ts` 或同级新文件，参照 `tests/harness/aci/interrupt-routing.test.ts` 先例。
- **Acceptance**: 上述用例全绿；`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 4. T4. `[implementation]` `onStream` 透传（`run()` opts → adapter.step）[blocks: T3]

- **Affects**: `src/harness/loop-engine.ts`（`run()` opts 类型加 `onStream?: (e: HarnessStreamEvent) => void`；透传 run → stepWithTrace → runModelPhase → raceModel → adapter.step）、`tests/harness/loop-engine.test.ts`。
- **实现要点**:
  - `LoopAdapter.step` 的 request 参数加可选 `onStream`（与 T3 的 types.ts 一致）；raceModel 的 `adapter.step(state, { tools, onStream }, compositeSignal)` 透传。
  - loop-engine 状态机 / StopReason / 权威历史 / `appendMessage` 零结构变更（D2）。
  - 无 `onStream` 时行为与现状逐字节一致（回归保护）。
  - **[ACR complexity 整改] 不放大 stepWithTrace**：透传只在 opts 层参数传递（run → stepWithTrace → runModelPhase → raceModel 各函数签名加一个可选参），`stepWithTrace`（251 行基线）内部**零新增逻辑行**——超阈基线只减不增（S5 diff 范围原则，基线本身的拆分不在本计划）。
- **测试覆盖**:
  - stub adapter emit text_delta → `run()` 的 opts.onStream 收到完整序列。
  - onStream 回调抛异常 → loop 不崩，最终 result 正常。
  - 无 onStream → 行为零变化。
- **Acceptance**: 上述用例全绿；`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 5. T5. `[implementation]` trace `stream` 布尔翻转 [parallel with T4] [blocks: T3]

- **Affects**: `src/harness/loop-engine.ts`（`recordLlmCall` 两处硬编码 `stream: false` → 按实际模式，loop-engine.ts:558,571——ACR 实测核出的行号，草案原值 559,572 漂移）、`tests/harness/trace/` 相关测试。
- **实现要点**:
  - 流式臂下 `recordLlmCall({ stream: true, ... })`；非流式臂保持 false。
  - 写入时机不变（ADR-0003 决策 11，turn 级）；不新增 record 类型（Postel's Law）。
- **测试覆盖**:
  - 流式臂 → trace JSONL `stream: true`；非流式臂 → `stream: false`（回归）。
- **Acceptance**: 上述用例全绿；`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 6. T6. `[implementation]` 装配 + chat 增量渲染 + 端到端实测 [blocks: T4, T5, T1]

- **Affects**: `src/config/env.ts`（`IKNOW_LLM_STREAM` 读取 + helper）、`src/cli/runtime.ts` + `src/session-api/hub.ts`（两装配点传入 stream 开关）、`src/cli/chat-session.ts`（spinner 接缝：「思考中…」→ 增量文本 → `clearErrLine()` + `formatRunHuman` 整体输出）、新测试。
- **实现要点**:
  - env 默认 `on`（T1 裁决）；非法值回退 `on` 不崩溃。
  - chat 增量渲染：`processChatLine` 拿 onStream 回调，把「思考中…」替换为滚动 text_delta；最终 `clearErrLine()` 接整体输出（对齐现有 spinner 接缝 `chat-session.ts:311-320`）。
  - ask（oneshot）不接 onStream（无增量价值，undefined 透传）；serve 预留路由不实现（D3）。
- **测试覆盖**:
  - env 读取：默认 on / off / 非法值回退。
  - chat 增量渲染：stub adapter emit → 输出含增量文本。
- **端到端实测**（D7 小样本补足）:
  - 9router 长响应（>16K token）+ thinking block + tool_use input_json_delta 透传完整性。
  - chat 入口端到端增量渲染（真实 9router）。
  - 无 key → Not run 记录 + 票保持 open 待 key，不阻塞合入。
- **Acceptance**: 单元用例全绿；`npm test` 全绿；端到端实测 Resolution comment 记录（或 Not run + 原因）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 7. T7. `[decision]` CLAUDE.md + CONTEXT.md 规范变更（单独提交）[blocks: T6]

- **Affects**: `CLAUDE.md`（锁定行「stream: false + parseLlmResponseJson」→「流式默认臂 + 非流式回退」）、`docs/CONTEXT.md`（line 137 / 191 过时词条清理）。
- **规范变更流程**（CLAUDE.md 要求）:
  1. 说明修改原因：流式臂已落地（T6），锁定行反映旧现状；parseLlmResponseJson 是死代码。
  2. 说明影响范围：CLAUDE.md「LLM 客户端」行 + CONTEXT.md 两条词条。
  3. 检查与 README / docs 冲突：grep 全仓 `stream: false` / `parseLlmResponseJson`，确认无其他引用。
  4. 单独提交，不与业务代码混合。
- **Acceptance**: T7 issue 有 Resolution comment 记录四项流程执行结果并 closed；`grep -n "parseLlmResponseJson" CLAUDE.md docs/CONTEXT.md` 零命中。

## 显式排除（Out of scope，与 #147 Resolution 一致）

- usage 消费与承载设计 → #160（grilling 在途）。
- serve SSE 路由实现、TUI/web 增量渲染 → 各入口实施票（本计划只定 chat 入口）。
- thinking_delta 流式下发 → 留位不发（v1），需要时扩展事件联合。
- #173 探针变量名漂移修复 → 独立 bug 票。

## 验收总门

`npm test`（vitest：unit + eval alignment + trajectory + harness）全绿；端到端实测轴记录（或 Not run + 原因）；CLAUDE.md / CONTEXT.md 规范变更单独提交。
