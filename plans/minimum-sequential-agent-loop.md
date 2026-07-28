# Plan: Minimum Sequential Agent Loop (016 Gate A)

> **Input spec**: `specs/minimum-sequential-agent-loop.md` (ACR all-yes PASS).
> **Prior decisions**: 016 Q1–Q6 Resolution, 013/014/015 frozen contracts. No open choices remain; all bullets are `[implementation]`.
> **Per-bullet commit rule**: 1 bullet = 1 commit, on its own branch off the active worktree base.
> **Per-ticket loop** (ADR-0012, verbatim): `tdd → typecheck+tests → code-review → verification-before-completion → commit`.

## Dependency graph (high-level)

```
T1 (skeleton + types)
 ├─ T2 (Registry + S13)        ┐
 ├─ T3 (Executor + ToolExecutionResult) ─┐ parallel after T1
 ├─ T4 (stubs)                        ─┘
 │   └─ T5 (Loop Engine + S1)
 │       └─ T6 (S2 single tool loop)
 │           └─ T7 (S3 multi tool serial)
 │               └─ T8 (S4 + S5 failures)
 │                   └─ T9 (S6–S9 stop reasons)
 │                       └─ T10 (S10 + S11 invariants)
 │                           └─ T12 (public export + full AC)
 └─ T11 (Anthropic Adapter offline) ─┘ (parallel with T2–T10) ─→ T12
```

## Tracer bullets

### T1. `[implementation]` Foundation skeleton + type spine
- **Affects**: `src/harness/errors.ts`; `src/harness/model-adapter/types.ts`; `src/harness/tools/types.ts`; `src/harness/index.ts`
- **Acceptance**: `npm run typecheck` 退出码 0;`src/harness/index.ts` 导出空 namespace(无运行时代码);三个错误类(`RegistryConstructionError` / `ProtocolError` / `ToolExecutionError`)与 `LoopState` / `Transition` / `StopReason` / `RunResult` / `ModelAdapter` 接口 / `ToolDef` / `Registry` 接口 / `ToolExecutionResult` 类型签名按 spec Code Style 区定义,strict + noUnusedLocals 通过。
- **Per-ticket loop**: tdd (skeleton test 验证 imports) → typecheck+tests → code-review → verification-before-completion → commit

### T2. `[implementation]` Registry with ajv constructor validation
- **Affects**: `src/harness/tools/registry.ts`; `src/harness/tools/tool-result.ts`; `package.json` (`ajv` + `ajv-formats` dep, pinned `^8.17.1` / `^2.1.1`); `tests/harness/tools/registry.test.ts` (S13)
- **Acceptance**: `createRegistry([...])` 对重复工具名 / 坏 JSON Schema / validator 编译失败抛 `RegistryConstructionError`;构造成功后 Registry 不可变(`Object.freeze`);S13 测试 3 类失败场景全过。
- **Per-ticket loop**: tdd (S13 failing test first) → typecheck+tests → code-review → verification-before-completion → commit

### T3. `[implementation]` Executor (serial, no-shortcircuit, no-retry)
- **Affects**: `src/harness/tools/executor.ts`; `tests/harness/tools/executor.test.ts`
- **Acceptance**: 单元测试覆盖三类失败(工具不存在 / 参数非法 / 工具运行时异常)+ 串行多调用顺序 + 失败后继续(无短路);所有失败形成身份匹配的 `ToolExecutionResult`(非抛错);严格校验用 ajv `strict: true`(不隐式转换、不裁剪未知字段、不猜测缺失值)。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit

### T4. `[implementation]` Stub model + stub tool
- **Affects**: `src/harness/stubs/stub-model.ts`; `src/harness/stubs/stub-tool.ts`; `tests/harness/stubs/` (最小调用验证)
- **Acceptance**: 替身 model 接受脚本化 responses 数组(每次 `step` 调用消费下一条);替身 tool 接受 `args` 返回可控成功 / 失败 / 异常;完全确定性(无时间 / 随机 / IO 依赖);替身不进生产装配路径(`src/cli/runtime.ts` / `src/session-api/` 不 import)。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit

### T5. `[implementation]` Loop Engine — S1 pure-text completion
- **Affects**: `src/harness/loop-engine.ts`; `tests/harness/loop-engine.test.ts` (S1 fixture)
- **Acceptance**: `run(userText, deps)` 在替身 model 发纯文本时返回 `stopReason="completed"` + `turnCount=1` + `messages=[user, assistant(text)]` + `finalText` 非空;S1 测试通过;`step` 函数实现最小版本(支持 continue / stop 分支,但 S1 阶段只走纯文本 stop 路径)。
- **Per-ticket loop**: tdd (S1 failing test first) → typecheck+tests → code-review → verification-before-completion → commit

### T6. `[implementation]` S2 single-tool-call closure
- **Affects**: `src/harness/loop-engine.ts`; `src/harness/model-adapter/types.ts` (可能补 `Adapter.encodeToolResults` 接口); `tests/harness/loop-engine.test.ts` (S2 fixture)
- **Acceptance**: 替身 model 先发 tool call、看到 tool_result 后发文本,Loop 跑出 `messages=[user, assistant(tool_use), user(tool_result), assistant(text)]` 四条顺序;S2 测试通过;Adapter 接口最小化(只暴露 step 需要的)。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit

### T7. `[implementation]` S3 multi-tool-call serial
- **Affects**: `src/harness/tools/executor.ts`; `src/harness/loop-engine.ts`; `tests/harness/loop-engine.test.ts` (S3 fixture)
- **Acceptance**: 同回合 N 个 tool calls 按出现顺序串行执行,按相同顺序回填到单条 user message(多 content blocks);S3 测试通过(`messages` 里 N 个 tool_use / N 个 tool_result 顺序一一匹配)。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit

### T8. `[implementation]` S4 + S5 tool failure surfaces
- **Affects**: `src/harness/tools/executor.ts`; `src/harness/tools/tool-result.ts` (失败 result 形状); `src/harness/model-adapter/anthropic-adapter.ts`(`is_error: true` 编码)— 注意:T8 与 T11 共享 anthropic-adapter.ts,**T11 可能在 T8 之前先做编码基础设施,或 T8 留下 stub adapter 的 `is_error` 编码桩,T11 替换**;`tests/harness/loop-engine.test.ts` (S4 + S5 fixture)
- **Acceptance**: S4 — 失败结果作为 `is_error: true` 的 tool_result 进入历史,模型下一轮可见并能修正;S5 — 同回合 3 调用,第 2 个失败不短路第 3 个,3 个结果都进历史且成功/失败可区分;两类失败标签在 `ToolExecutionResult` 字段上结构化(非异常)。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit

### T9. `[implementation]` S6 + S7 + S8 + S9 stop reasons
- **Affects**: `src/harness/loop-engine.ts`; `src/harness/model-adapter/anthropic-adapter.ts`(可能补 stop reason 解释); `tests/harness/loop-engine.test.ts` (S6–S9 fixture)
- **Acceptance**:
  - S6: `turnCount >= maxTurns` 时 `stopReason="maxTurns"` 且**未多调一次模型**(调用前检查);
  - S7: 非成功停止(truncation/refusal)→ `stopReason="nonSuccessStop"`,截断/拒绝文本不作成功最终答案;
  - S8: 空最终响应 → `stopReason="emptyFinalResponse"`,空响应**不**进入权威历史;
  - S9: 协议错误回合 → `stopReason="protocolError"`,整坏回合不进入历史,不触发工具执行。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit

### T10. `[implementation]` S10 + S11 structural invariants
- **Affects**: `src/harness/loop-engine.ts`(可能仅追加 assert 块,不改主逻辑); `tests/harness/loop-engine.test.ts` (S10 + S11 fixture)
- **Acceptance**:
  - S10 append-only 不可变: 跑完 S1 路径后,`finalResult.messages` 引用从未被原地修改;通过 Object.freeze + 跟踪 step 前后 messages 引用比较实现;
  - S11 跨 run 不污染: 用同一 `step` / `run` 函数连续跑两次不同输入,`run #2` 的 `messages` 数组**不**含 `run #1` 任何消息(纯 B 兑现)。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit

### T11. `[implementation]` Anthropic Adapter offline 7-class acceptance
- **Affects**: `src/harness/model-adapter/anthropic-adapter.ts`; `tests/harness/model-adapter/anthropic-adapter.test.ts`
- **Acceptance**: 014 冻的 7 类离线样例全过 — 纯文本完成 / 文本+单 tool call / 同回合多 tool calls / 截断或拒绝 / 空最终响应 / 缺失必要 block 或调用身份 / 流中断不提交半回合;Adapter 用 `@anthropic-ai/sdk`;不连真实模型(全部 fixture 离线 JSON);**注:与 T8 共享 anthropic-adapter.ts**,若 T11 先做编码基础设施、T8 复用其 `is_error` 路径;若 T8 先做,T11 替换 stub。
- **Per-ticket loop**: tdd (7 类 failing fixture first) → typecheck+tests → code-review → verification-before-completion → commit

### T12. `[implementation]` Public export + full acceptance + Gate B gate
- **Affects**: `src/harness/index.ts`; 全部 `src/harness/**` + `tests/harness/**`(只读审计);`docs/handoff/016-completion.md`(可选完成证据)
- **Acceptance**:
  - `src/harness/index.ts` 公共导出:`run` / `createLoopEngine` / `createAdapter`;
  - `npm run typecheck` 退出 0;
  - `npm test` 退出 0;
  - spec Success Criteria 16 条全部 yes;
  - 代码审查:`src/harness/**` 全文 `grep` 无 retry / cancel / timeout / trace / checkpoint / 并发调度关键字(Gate B 能力守门);
  - 可选:在 `docs/handoff/` 写 016-completion.md 记录验证证据。
- **Per-ticket loop**: tdd (公共导出 smoke test) → typecheck+tests → code-review → verification-before-completion → commit

## Parallelism matrix

| After | Parallelizable bullets |
|---|---|
| T1 | T2, T3, T4, T11 (4-way) |
| T2 + T3 + T4 | T5 (needs T4 stub + T2/T3 types) |
| T5 | T6 |
| T6 | T7 |
| T7 | T8 |
| T8 | T9 |
| T9 | T10 |
| T10 + T11 | T12 |

T11 独立 chain(只依赖 T1),可与 T2–T10 主 chain 大部分并行。

## Pre-flight checklist (run before declaring plan done)

- [ ] All 12 bullets carry `[implementation]` tag, name, files, binary acceptance
- [ ] Each bullet embeds the per-ticket loop verbatim (`tdd → typecheck+tests → code-review → verification-before-completion → commit`)
- [ ] Dependency graph has no cycles
- [ ] Parallelism opportunities marked (matrix above)
- [ ] No bullet touches `src/agent-loop/` (per 016 Q6 migration limit)
- [ ] No bullet reuses `src/tools/registry.ts` as ACI Registry (per 015)
- [ ] No bullet pre-builds Gate B capability (retry/cancel/timeout/trace/checkpoint/concurrency/memory)
- [ ] ACR 5-verdict frame still PASS after decomposition (re-check against `specs/minimum-sequential-agent-loop.md` ACR block)