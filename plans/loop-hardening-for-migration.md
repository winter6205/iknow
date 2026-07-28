# Plan: Loop Hardening for Migration (017 Gate B — 物理必需层)

> **Spec**: `specs/loop-hardening-for-migration.md`（ACR 5/5 PASS）
> **Tracker**: GitHub issues（`ready-for-agent` label）— gh CLI 可用
> **Base branch**: `worktree-spec-017-loop-hardening`（或合并后的 master）
> **依赖**: PR #27（017 ticket Q1–Q7 Resolution）合并后 Cross-references 完整

---

## Section 1 — Context-Loop Pre-Check

- `docs/CONTEXT.md` 已读：Loop Engine / append-only messages / turnCount / stub model+tool 四个术语引入 spec Glossary。
- `docs/adr/` 为空：无 in-scope ADR。决策契约来源 = 014/015 ticket + 016 Resolution + 017 Resolution。
- 无 ADR 矛盾需标注。

## Section 2 — ACR 5-Verdict Block（引自 spec）

```
bounded-context-guardian: yes — 变更限于 src/harness/ 已有四模块 + 2 新增文件，能力切分不变。
defensive-contract-validator: yes — S12–S17 覆盖 5 类边界（empty/negative/overflow/exception/concurrent N/A）。
error-handling-enforcer: yes — 不新增错误类；超时/取消通过 StopReason + execution_failed 结构化表达。
complexity-anti-drift: yes — 纯函数延续；LoopEngineDeps 4→7（3 可选）；computeTotals reduce nesting ≤ 2。
minimal-change-verifier: yes — scope 严格 src/harness/** + tests/harness/**；新增 2 文件；单 task 单 commit。
```

## Section 3 — Tracer Bullets（依赖序）

---

### T1. `[decision]` LoopAdapter vs ModelAdapter signal 扩展形状

- **背景**: 代码里有两个 adapter 接口：
  - `ModelAdapter`（`model-adapter/types.ts:93`）：`step(state, request) => Promise<AssistantTurnResult>`
  - `LoopAdapter`（`loop-engine.ts:38`）：扩展 ModelAdapter + `encodeUserText` + `encodeToolResults`
  - Loop Engine 实际调用的是 `LoopAdapter.step`（loop-engine.ts:119）
  - Spec 只提了 "ModelAdapter.step 加 signal 参"
- **决策**: 两个接口都加 signal 参。`ModelAdapter.step(state, request, signal?)` + `LoopAdapter.step(state, request, signal?)`。LoopAdapter 是 Loop Engine 的直接消费接口，不加 signal 则 Loop Engine 无法透传。ModelAdapter 是公共契约，不加则 Anthropic Adapter 实现无法接收 signal。
- **Affects**: 无代码变更（纯决策记录）
- **Acceptance**: 决策写入本 plan，T2 实施时引用。□

---

### T2. `[implementation]` 类型层：StopReason + ToolExecutionContext + LoopTrace + 接口扩展

- **Affects**:
  - `src/harness/model-adapter/types.ts` — StopReason 加 `"cancelled" | "timeout"`；ModelAdapter.step 加 `signal?: AbortSignal`
  - `src/harness/tools/types.ts` — 新增 `ToolExecutionContext`；ToolHandler 加可选 `ctx?`；Executor.executeAll 加 `signal?`
  - `src/harness/loop-trace.ts` — **新增**：TurnTrace / Totals / LoopTrace 类型 + `computeTotals` 纯函数
  - `src/harness/loop-engine.ts` — LoopAdapter.step 加 `signal?`（T1 决策）；LoopEngineDeps 加 `timeoutMs?` / `modelTimeoutMs?` / `toolTimeoutMs?`
  - `src/harness/index.ts` — 导出新类型（LoopTrace / TurnTrace / Totals / ToolExecutionContext）
- **Acceptance**:
  - `npm run typecheck` 退出码 0（类型扩展为可选/追加，不破坏现有代码）□
  - `npm test` 退出码 0（212 现有测试不回归）□
  - `loop-trace.ts` 导出 `computeTotals`，输入空数组返回全零 Totals □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

**实施要点**:

- StopReason 末尾追加，不重排（spec A5）
- ToolHandler 扩展为 `(input: unknown, ctx?: ToolExecutionContext) => ...`，015 老 handler `(input) => ...` 继续合法（TS 函数参数逆变兼容）
- computeTotals 是纯 reduce，nesting ≤ 2（spec A7）
- LoopEngineDeps 超时字段全可选，运行时兜底 60000（spec A3）

---

### T3. `[implementation]` Executor：signal 透传 + Promise.race 超时 + ctx 传递

- **Affects**:
  - `src/harness/tools/executor.ts` — `executeAll(calls, signal?)` → `runOne(call, signal?)` → `handler(input, ctx: { signal })`；单次 handler 包 `Promise.race([handler(...), timeoutPromise])`
  - `tests/harness/tools/executor.test.ts` — 新增：超时 → execution_failed（message "timeout"）；ctx.signal 透传验证
- **Acceptance**:
  - 现有 executor 9 tests 不回归 □
  - 新 test：handler 延迟 > toolTimeoutMs → `kind="execution_failed"`, `message` 含 "timeout" □
  - 新 test：handler 接收 ctx.signal，abort 后 handler 抛 AbortError → `kind="execution_failed"` □
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[parallel]` 与 T4

**实施要点**:

- Promise.race 强制超时，不依赖 handler 内部支持（spec A3 / Q2）
- 超时值从 `createExecutor(registry, opts?)` 或 `executeAll(calls, signal?, timeoutMs?)` 传入——具体签名 writing-plans 留给实施者，但必须是可选参数
- signal 原样透传到 ctx.signal，不创建子 signal（spec A4）
- 超时和取消是两条独立路径：超时 → message "timeout"；abort → message "cancelled"（spec A6）

---

### T4. `[implementation]` Stubs：signal-aware stub-model + stub-signal-tool

- **Affects**:
  - `src/harness/stubs/stub-model.ts` — step 加 `signal?` 参；新增可配置延迟（`delayMs?`）+ signal 绑定（abort 后抛 AbortError 或形成失败）
  - `src/harness/stubs/stub-signal-tool.ts` — **新增**：示例 stub tool，handler 接 `ctx.signal`，abort 后抛 AbortError
  - `tests/harness/stubs/stub.test.ts` — 新增：stub-model 延迟 + signal 测试；stub-signal-tool abort 测试
- **Acceptance**:
  - 现有 stub 4 tests 不回归 □
  - 新 test：stub-model 配置 delayMs > 0，step 延迟返回 □
  - 新 test：stub-model 绑 signal，abort 后 step 抛错或形成失败 □
  - 新 test：stub-signal-tool 接 ctx.signal，abort 后 handler 抛 AbortError □
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[parallel]` 与 T3

**实施要点**:

- stub-model 延迟用 `setTimeout` + `Promise.race`（测试替身允许时间依赖，因为测试控制时间）
- stub-signal-tool 是 S17 守门的验证载体（spec A9）
- stubs 不进生产装配路径（继承 016 约束）

---

### T5. `[implementation]` Loop Engine：signal + timeout + trace 累积 + 在途收尾

- **Affects**:
  - `src/harness/loop-engine.ts` — step(state, deps, signal?) 内部：performance.now() 计时 + signal.aborted 检查 + 在途收尾分支（模型在途 / 工具在途）；run(userText, deps, signal?) → `{ result, trace }`（immutable 累积 TurnTrace[]，run 结束 computeTotals）；createLoopEngine 透传 signal
  - `tests/harness/loop-engine.test.ts` — 新增 S12–S17（续段或新文件，实施者定）
- **Acceptance**:
  - S12：signal abort 模型在途 → stop `cancelled` + 整回合不进历史 + trace 末项 `signalAborted=true` □
  - S13：signal abort 工具在途 → execution_failed（message "cancelled"）进历史 + stop `cancelled` + trace 末项 `signalAborted=true` □
  - S14：timeout 模型在途 → stop `timeout` + 整回合不进历史 + trace 末项 `timeoutHit=true` □
  - S15：timeout 工具在途 → execution_failed（message "timeout"）进历史 + stop `timeout` + trace 末项 `timeoutHit=true` □
  - S16：多回合 run → trace.turns.length == turnCount + 字段齐全 + totals 正确 + **trace 不含 payload** □
  - S17：stub-signal-tool 接 ctx.signal → abort → AbortError → execution_failed □
  - 016 S1–S11 全过不回归 □
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T2, T3, T4]`

**实施要点**:

- 判定顺序（spec A6）：signal.aborted 检查 → adapter.step（模型阶段）→ executor.executeAll（工具阶段）
- 模型在途 abort/超时：finalState = step 入口 state，整回合不进历史（与 protocolError 同分支）
- 工具在途 abort/超时：assistant 回合已追加（不可回滚）；在途 tool call 填 execution_failed；所有 tool_result 编码为一条 user message 原子追加后 stop
- run 返回 `{ result: RunResult, trace: LoopTrace }`（spec A1）；RunResult 形状零变更
- trace 累积用 `[...prevTurns, newTurn]`（immutable）；totals 用 computeTotals 一次性 reduce（spec A7）
- createLoopEngine 返回的 run/step 闭包加 signal 可选参

---

### T6. `[implementation]` Anthropic Adapter：signal + timeout 绑定

- **Affects**:
  - `src/harness/model-adapter/anthropic-adapter.ts` — step(state, request, signal?) 接收 signal；AnthropicAdapterOptions 加可选 `timeoutMs?`；step 内部把 signal + timeout 绑到 SDK client/fetch（离线模式下为 no-op，但签名就位）
  - `tests/harness/model-adapter/anthropic-adapter.test.ts` — 新增：signal 传入后 step 签名兼容；timeout 选项接受
- **Acceptance**:
  - 现有 adapter 9 tests 不回归 □
  - 新 test：step 接受 signal 参（传入不报错）□
  - 新 test：AnthropicAdapterOptions 接受 timeoutMs（传入不报错）□
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[parallel]` 与 T5（T6 只依赖 T2 类型层）
- `[blocks: T2]`

**实施要点**:

- 当前 adapter 是离线实现（脚本化 SdkMessage 数组），signal/timeout 在离线模式下无实际效果
- 签名就位是为了 018 接真实 SDK 时零改签名
- 不在离线模式下模拟超时（那是 stub-model 的事，T4）

---

### T7. `[implementation]` 集成验证 + 公共出口 + 条件式修复层守门

- **Affects**:
  - `src/harness/index.ts` — 确认所有新类型/函数已导出（LoopTrace / TurnTrace / Totals / ToolExecutionContext / computeTotals）
  - 全量 `npm test` + `npm run typecheck`
  - 代码审查：确认 `src/harness/` 不含条件式修复层
- **Acceptance**:
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0（212 + 新增全过）□
  - 代码审查确认无：自动重试 / token-cost 护栏 / trace B 层字段 / 工具分类超时 / 总耗时独立 stop / OTel-metrics-span 树 □
  - `index.ts` 导出 LoopTrace / TurnTrace / Totals / ToolExecutionContext / computeTotals □
  - 015 ToolHandler / ModelAdapter.step / StopReason 扩展均为向后兼容方式 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T5, T6]`

---

## Dependency Graph

```
T1 [decision]
 │
 ▼
T2 [implementation] ── 类型层
 │
 ├──► T3 [implementation] ── Executor ──┐
 │    [parallel]                        │
 ├──► T4 [implementation] ── Stubs ────┤
 │    [parallel]                        │
 │                                      ▼
 ├──► T5 [implementation] ── Loop Engine（S12–S17）
 │    [blocks: T2, T3, T4]              │
 │                                      │
 └──► T6 [implementation] ── Adapter ──┤
      [blocks: T2]                      │
      [parallel with T5]               ▼
                                T7 [implementation] ── 集成验证
                                [blocks: T5, T6]
```

## Verification Checklist

- [ ] Plan has ≥ 3 tracer bullets → **7 bullets**
- [ ] Each bullet has 1+ binary acceptance criterion → yes
- [ ] Each bullet maps to exactly 1 commit → yes
- [ ] Bullets ordered by dependency → yes（T1 → T2 → T3/T4 parallel → T5/T6 parallel → T7）
- [ ] Plan lives in `plans/loop-hardening-for-migration.md` → yes
- [ ] ACR 5-verdict block present in Section 2 → yes
- [ ] Context-loop pre-check in Section 1 → yes
