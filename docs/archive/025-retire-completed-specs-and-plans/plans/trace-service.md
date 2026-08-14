# Plan: Trace Service (A-scenario local debug observability)

> **Spec**: `specs/trace-service.md`（ACR 5/5 PASS）
> **ADR**: `docs/adr/0003-trace-service-domain-interface.md`（14 条决策）
> **Tracker**: GitHub issues（`ready-for-agent` label）— gh CLI 可用
> **Base branch**: `worktree-spec-064-trace-service`（或合并后的 master）
> **Origin**: GH issue #64 (winter6205/iknow)

---

## Section 1 — Context-Loop Pre-Check

- `docs/CONTEXT.md` 已读：`LoopTrace`（A 层结构元数据，不含 payload）/ `turnCount` / `append-only messages` / `in-flight closeout` / `StopReason` 7 类联合——spec Glossary 引用，不重定义。
- `docs/adr/` 已读：ADR-0001（env 命名 `IKNOW_*`）/ ADR-0002（web UI，与本 plan 无关）/ ADR-0003（本 plan 的决策来源）。
- 无 ADR 矛盾需标注。ADR-0003 是本 plan 的唯一决策契约。

## Section 2 — ACR 5-Verdict Block（引自 spec）

```
bounded-context-guardian: yes — 新模块 src/harness/trace/ 独立于 loop-trace.ts（017 A7 锁不动）。
defensive-contract-validator: yes — 5 类边界覆盖（empty=Noop / negative=undefined parent / overflow=capture 开关 / concurrent=N/A 单线程 / exception=safeTrace）。
error-handling-enforcer: yes — 三层错误面（IO 错误 / 调用方契约 / harness cancelled-timeout）各有明确处理路径。
complexity-anti-drift: yes — 3 方法接口 + ~20 字段/记录；safeTrace 单函数；无超阈值函数。
minimal-change-verifier: yes — 1 新目录 + 1 可选字段 + ~20 行埋点 + 2 CLI flag + 1 .gitignore 行；零新 runtime dep。
```

## Section 3 — Tracer Bullets（依赖序）

---

### T1. `[decision]` 接口契约 + ADR — **已完成**

- **决策**: 14 条决策已落入 ADR-0003 + spec。本 bullet 不再执行。
- **Affects**: `docs/adr/0003-trace-service-domain-interface.md` + `specs/trace-service.md`（已 commit 311a175）
- **Acceptance**: ADR + spec 存在且 ACR 5/5 PASS。✅

---

### T2. `[implementation]` TraceService 接口 + NoopTraceService + safeTrace + OTel 翻译桩

- **Affects**: `src/harness/trace/` 新目录（接口类型 / Noop 实现 / safeTrace wrapper / OTel 翻译桩 / 公共出口）+ 对应单元测试
- **Acceptance**:
  - `TraceService` 接口恰好 3 个公共方法，每个标注 `@throws never` □
  - `NoopTraceService` 三方法零副作用（不写盘、不 IO、不 console）□
  - `safeTrace` 吞异步异常返回 `undefined`，不吞同步编程错误 □
  - OTel 翻译桩调用时抛 "B-scenario not implemented"，`safeTrace` 包裹后不影响调用方 □
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

**约束**（来自 ADR-0003 / spec，不是实现指导）:

- 接口形状 = spec §Code Style 的 3 方法签名（`recordLlmCall` / `recordToolCall` / `recordTurn`）
- NoopTraceService 返回值语义 = ADR §Decision 5（ID 由 TraceService 生成；Noop 返回空串或 undefined，实施者定）
- safeTrace 契约 = ADR §Decision 13（`Promise<T | undefined>`，never throws）
- 文件拆分 / 命名 / 导出方式 = 实施者自由（spec 只定职责切分，不定文件名）

---

### T3. `[implementation]` JsonlTraceService（单文件 append，snake_case 转换）

- **Affects**: `src/harness/trace/` 内新增 JSONL 写入实现 + 对应单元测试
- **Acceptance**:
  - 写入产出合法 JSONL（每行一个 JSON 对象，无嵌入换行）□
  - JSONL 字段名为 snake_case（TS 侧 camelCase → 盘上 snake_case，转换集中在一处）□
  - `parentLlmCallId: undefined` → JSONL 里 `parent_llm_call_id: null`（字面 null）□
  - 写盘失败（注入 always-throw writer）→ 不抛异常，返回 `undefined`，`console.warn` 一次 □
  - 不 fsync（ADR §Decision 12）□
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[parallel]` 与 T4

**约束**:

- 写入方式 = `fs.appendFileSync`（ADR §Decision 11，同步 append，不用 stream）
- 字段命名转换 = 集中在 JSONL 写入层（ADR §Decision 8），不散在调用方
- 内容捕获 = `*_captured` 布尔开关，默认 false（spec §Code Style field shape）
- 文件路径解析 / rotation / 多文件 = 不做（ADR §Decision 3 + spec §Boundaries Never do）

---

### T4. `[implementation]` LoopEngine 注入点（可选 `trace?` + 4 处埋点）

- **Affects**: `src/harness/loop-engine.ts`（`LoopEngineDeps` 加可选字段 + `stepWithTrace` 内 4 处 `await safeTrace(...)` 埋点）+ 对应测试
- **Acceptance**:
  - `LoopEngineDeps.trace` 缺省时行为与 #64 前**字节级一致**（spec 判据 5）□
  - 注入 NoopTraceService 时行为同样字节级一致 □
  - 注入 JsonlTraceService 时 JSONL 产出 turn → llm → tool(s) 顺序记录 □
  - `recordLlmCall` 返回 `undefined` 时 `recordToolCall` 仍被调用（`parentLlmCallId: undefined`）□
  - 016 S1–S11 + 017 S12–S17 全过不回归 □
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[parallel]` 与 T3
- `[blocks: T2]`

**约束**:

- 埋点数量 = 4（model 阶段入口 / 出口、tool 阶段入口、turn 收尾）——spec §Project Structure
- 埋点方式 = `await safeTrace(() => traceService.recordXxx(...))`——ADR §Decision 13
- `recordTurn` 调用时机 = step 结束时（ADR §Decision 11，实时写盘）
- `loop-trace.ts` 零改动（spec 判据 12，017 A7 锁）
- 具体埋点行号 / await 位置 / 变量命名 = 实施者自由

---

### T5. `[implementation]` CLI `--trace-out` flag（ask + serve）

- **Affects**: `src/cli.ts`（ask + serve 子命令加 `--trace-out <file>` flag / `IKNOW_TRACE_OUT` env 读取）+ `.gitignore`（加 `trace.jsonl`）+ 对应测试
- **Acceptance**:
  - `iknow ask "q"` 无 flag → 默认写 `./trace.jsonl` □
  - `iknow ask "q" --trace-out /tmp/x.jsonl` → 写指定路径 □
  - `IKNOW_TRACE_OUT=/tmp/y.jsonl iknow serve` → 写指定路径 □
  - flag 优先级 > env > 默认（ADR §Decision 4 + spec 判据 14）□
  - `chat` 子命令**不接受** `--trace-out`（spec §Boundaries Never do）□
  - `trace.jsonl` 在 `.gitignore` 中 □
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T3, T4]`

**约束**:

- 覆盖范围 = ask + serve（ADR §Decision 10），chat 不接
- 默认路径 = `./trace.jsonl`（ADR §Decision 3 + 2026-07-31 grilling 决策）
- conversation_id 来源 = ask 路径自动生成 UUID / serve 路径用 session.id（ADR §Decision 4）
- 具体 flag 解析方式（argparse 库 / 手写）= 实施者自由（沿用 cli.ts 现有风格）

---

### T6. `[implementation]` 集成验证（harness 端到端 + 字节级一致 + 条件式修复层守门）

- **Affects**: `tests/harness/trace-integration.test.ts`（或等价集成测试文件）+ 全量回归
- **Acceptance**:
  - stub model + stub tool 跑完整 step：纯文本 turn / 单工具 turn / 多工具 turn / cancelled / timeout 五种场景 □
  - 无 trace 注入 vs NoopTraceService 注入：harness 输出字节级一致（spec 判据 5）□
  - JsonlTraceService 注入：JSONL 记录顺序 = turn → llm → tool(s) → turn，`parent_llm_call_id` 链完整 □
  - 注入 always-throw writer：harness 正常完成，JSONL 有 `parent_llm_call_id: null` 孤儿记录 □
  - 代码审查确认 `src/harness/` 不含条件式修复层（自动重试 / token-cost 护栏 / trace B 层字段 / OTel-metrics-span 树）□
  - `src/harness/loop-trace.ts` git diff 为空（017 A7 锁）□
  - `npm run typecheck` + `npm test` 退出码 0（全量）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T3, T4, T5]`

---

## Dependency Graph

```
T1 [decision] ✅ 已完成
 │
 ▼
T2 [implementation] ── 接口 + Noop + safeTrace + OTel 桩
 │
 ├──► T3 [implementation] ── JsonlTraceService ──┐
 │    [parallel with T4]                         │
 │                                               │
 └──► T4 [implementation] ── LoopEngine 注入 ───┤
      [parallel with T3]                        │
      [blocks: T2]                              ▼
                                        T5 [implementation] ── CLI flag
                                        [blocks: T3, T4]
                                                │
                                                ▼
                                        T6 [implementation] ── 集成验证
                                        [blocks: T3, T4, T5]
```

## Verification Checklist

- [ ] Plan has ≥ 3 tracer bullets → **6 bullets**（T1 已完成，T2-T6 待执行）
- [ ] Each bullet has 1+ binary acceptance criterion → yes
- [ ] Each bullet maps to exactly 1 commit → yes
- [ ] Bullets ordered by dependency → yes（T1 → T2 → T3/T4 parallel → T5 → T6）
- [ ] Plan lives in `plans/trace-service.md` → yes
- [ ] ACR 5-verdict block present in Section 2 → yes
- [ ] Context-loop pre-check in Section 1 → yes
- [ ] 实施要点只写约束来源（ADR / spec 条目），不写代码片段 → yes
