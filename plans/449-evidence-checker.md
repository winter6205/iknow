# Plan: 449a — evidence-checker：证据优先判定的纯函数规则引擎（三态 verdict + 三防 + D2 探测）

**Goal:** 实现 #449 证据优先判定的确定性前级——纯函数规则引擎核对主会话 transcript 里的真实执行证据（bash tool_use + exit 0 + 框架 green marker + 时效 + 无削弱痕迹），产出三态 verdict（SUFFICIENT / CONTRADICTED / INSUFFICIENT），并附 D2 自动探测默认验证命令。
**Architecture:** 纯函数层（G2-1 明示落点 `src/harness/verify/evidence-checker.ts` + `command-probe.ts`），零 IO、零 LLM、零 loop 接线、零新依赖；输入 = `ReadonlyArray<AnthropicNativeMessage>` 只读快照 + `claimIndex` 标量，输出 = `EvidenceReport`；6 条检查全部封装在 checker 内部，调用方只消费 verdict 不数条件。编排缝与 VerificationRecord 扩展见 `specs/verify-goal-gate.md`（旧 `plans/449-verify-evidence-first-loop.md` 已归档），本 plan 不接线。
**Tech Stack:** TypeScript + Node（ESM，tsc strict），无新依赖。纯正则 + 字符串解析（框架 marker 识别），不引入 parser 库。
**Spec link:** `specs/449-evidence-checker.md`（ACR PASS 5/5，2026-08-16）
**前置依赖**: 无；下游编排：`specs/verify-goal-gate.md`（verdict 契约消费方）。
**Tracker**: GitHub（label `ready-for-agent`，native blocking via addBlockedBy；票创建留待 operator 放行）

---

## Architecture Change Reviewer verdict

引自 spec（Round 1，2026-08-16，OVERALL PASS → hand to writing-plans）：

- bounded-context-guardian: yes — checker 冻结为纯 import，SC1 给出可执行 grep 禁项检查；唯一跨 context import（AnthropicNativeMessage 自 model-adapter/types）与 verify-loop.ts:28 既有同款，无反向依赖。
- defensive-contract-validator: yes — 矩阵覆盖 empty（空 messages / 无 bash / claimIndex=0）、negative（exit≠0 / 畸形 tool_result JSON / is_error）、overflow（多条不合格 + 恰好一条合格）、concurrent（N/A 纯函数无状态，defensible）、exception（畸形 shape 不 crash → INSUFFICIENT），另设五框架 × 三防专项测试文件。
- error-handling-enforcer: yes — fail-closed 显式（"歧义一律不 SUFFICIENT"）+ 随机残缺 fixture 永不 SUFFICIENT 属性测试；CONTRADICTED 限于二进制删除/清空测试文件事实（取自 tool_use args）；软信号仅记录；probeVerifyCommand 冲突返回 null；JSON 解析失败 → exitCode null → INSUFFICIENT，无静默放行。
- complexity-anti-drift: yes — 两个单一职责纯模块（规则引擎 vs D2 探测）、types.ts 仅类型扩展、零新依赖、零 IO/LLM/trace；6 条检查封装在单一 verdict 契约后，非 god-function。
- minimal-change-verifier: yes — 1 logical task（证据规则引擎）；loop 接线与 VerificationRecord trace 字段扩展显式移交 sibling spec；verify-loop.ts / verdict.ts / classifier.ts 明示不改。

Ground truth 核验（reviewer 实证 + 本 plan 逐项复查）：`verify-loop.ts:610` produceObservation 缝确认；`src/harness/aci/tools/bash.ts:79-83` 返回 `{code,stdout,stderr}` + `src/harness/tools/executor.ts:46` JSON 序列化确认；`tool-result.ts:31/44` is_error + `[execution_failed]` 前缀确认；`runner.ts:16` stdout 12k / `executor.ts:30` 硬上限 20000 确认；`compress/window.ts:14` preserveToolPairs 保证 compact 后 tool_use↔tool_result 成对，checker 只读快照输入仍配对（OQ2 一致）。非阻塞观察：`^Exit code (\d+)` 回退正则当前无生产 producer（模型面 bash 恒为 JSON shape），属防御性兜底，非 fail-open 风险。

---

## Tracer bullets

> Per-ticket loop（ADR-0012）为强制：每个 `[implementation]` bullet 的 `Per-ticket loop` 行不可省略。
> 每 bullet 的测试文件落 `tests/harness/verify/evidence-checker/` 目录（T5 的 command-probe 例外，落 `tests/harness/verify/command-probe.test.ts`，与 spec Project Structure 一致）。

### T1. `[implementation]` types.ts 类型契约扩展（EvidenceVerdict / EvidenceReport / TestRunEvidence / GamingSignal）

- **Affects**: `src/harness/verify/types.ts`
- **Acceptance**: `npm run typecheck` 通过; `grep -n "EVIDENCE_SUFFICIENT\|EVIDENCE_CONTRADICTED\|EVIDENCE_INSUFFICIENT" src/harness/verify/types.ts` 三态命中（SC2）; `grep -n "TestRunEvidence\|EvidenceReport\|GamingSignal" src/harness/verify/types.ts` 命中; 纯类型扩展零 runtime 变化——`readonly` 字段与 spec Code Style 契约形状逐字对齐（`framework: "pytest" | "jest" | "vitest" | "go" | "cargo" | null`、`exitCode: number | null`、`stale: boolean` 等）
- **Rationale**: 类型契约是 evidence-checker 实现的编译面前置;checkEvidence 函数签名（含 `AnthropicNativeMessage`）留到 T2 落 `evidence-checker.ts`，types.ts 只承载纯数据型，保持 T1 零跨 context import。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` evidence-checker 骨架：extractTestRuns + exit code 双路解析 + fail-closed 兜底

- **Affects**: `src/harness/verify/evidence-checker.ts`（新）, `tests/harness/verify/evidence-checker/exit-code.test.ts`（新）
- **Acceptance**: `npx vitest run tests/harness/verify/evidence-checker` 全绿——`exit-code.test.ts` 三路用例（SC4）：结构化 JSON `{code, stdout, stderr}`（bash.ts:79-83 形状）→ exitCode = code；非 JSON 文本 `^Exit code (\d+)` 正则回退 → code；`is_error: true` + `[execution_failed]` 前缀 → exitCode = null;空输入 fail-closed（A8）:messages 空 / 无任何 bash tool_use → INSUFFICIENT;tool_result 非 JSON 且无 Exit code 行 → 该 run exitCode null → INSUFFICIENT;畸形 message shape（缺 content）→ 不 crash → INSUFFICIENT;`checkEvidence` 导出、返回 `EvidenceReport`（含 reasons / runs / gamingSignals / stale 字段形状）
- **Rationale**: 骨架先落「bash 测试执行提取 + 双路 exit code + fail-closed 空输入」的判定基座，marker/三防/CONTRADICTED 在其上分层;唯一跨 context import 在此 bullet 定锚——`import type { AnthropicNativeMessage, AnthropicContentBlock } from "../model-adapter/types.js"`（与 verify-loop.ts:28 既有同款 import 路径，ACR 认可）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` 五框架 green marker + 弱绿四形态 + 吞失败四 pattern + 时效（messages index 时序 + doc-only 豁免）

- **Affects**: `src/harness/verify/evidence-checker.ts`（扩展）, `tests/harness/verify/evidence-checker/frameworks.test.ts`（新）, `tests/harness/verify/evidence-checker/three-guards.test.ts`（新）
- **Acceptance**: `frameworks.test.ts` 五用例全绿（SC3）——pytest（count+duration 双子句摘要行）/ jest（`N total`）/ vitest（`Tests: N passed`）/ go（`ok pkg`）/ cargo（`test result:`）各一条「exit 0 + green 摘要 + 无编辑」→ SUFFICIENT（A4 阈值，一条即够）;`three-guards.test.ts` 全绿（SC5）——弱绿四形态逐个（`0 tests run` / `collected 0 items` / `no tests found` / `-k`、`-t`、`::` 窄跑）→ 非 SUFFICIENT（A6）;吞失败四 pattern 逐个（`|| true` / `|| exit 0` / `; exit 0` / `--passWithNoTests`）→ 该证据作废 → INSUFFICIENT（A7 硬信号）;时效——绿测试 turn 之后、claimIndex 之前存在 `edit_file`/`write_file` 且目标路径非 doc-only → `stale: true` → INSUFFICIENT;doc-only 豁免（`.md`/`.txt`/`docs/`）→ 仍 SUFFICIENT;恰好一条合格证据 + 多条不合格 → SUFFICIENT（G2-4 阈值正反）
- **Rationale**: marker 只从框架摘要行读数字（绝不扫描任意输出）、时序用 messages index（不用 mtime/diff/git）是 R2 移植的核心纪律;三防与 marker 同文件扩展，顺序推进避免同文件并行冲突。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` CONTRADICTED（二进制事实）+ gamingSignals 软信号只记录 + fail-closed 属性式收口

- **Affects**: `src/harness/verify/evidence-checker.ts`（扩展）, `tests/harness/verify/evidence-checker/contradicted.test.ts`（新）, `tests/harness/verify/evidence-checker/gaming-soft.test.ts`（新）, `tests/harness/verify/evidence-checker/fail-closed.test.ts`（新）
- **Acceptance**: `contradicted.test.ts` 全绿（SC6）——`write_file` 清空测试文件（内容 ≈ 空）→ CONTRADICTED;bash `rm` 测试文件 → CONTRADICTED;数字类信号（断言减少）永不 CONTRADICTED（反向断言）;`gaming-soft.test.ts` 全绿（SC9）——断言数减少 / 新增 skip/xfail / `git commit --no-verify|-n` 命中 → `gamingSignals` 非空且 **verdict 不变**（A7 软信号，count-based 永不指控）;`fail-closed.test.ts` 全绿（SC7）——claimIndex = 0 → INSUFFICIENT;畸形 message 系列 → 不 crash INSUFFICIENT;属性式用例：随机残缺 fixture 集（缺 content / 空 runs / 全 null exitCode）任一永不 SUFFICIENT（A8）
- **Rationale**: CONTRADICTED 是唯一硬性二元否决，必须限死「清空/删除测试文件」二进制事实（取自 tool_use args），与软信号区分定罪级——gamingSignals 随 trace 落盘（字段扩展在 sibling spec），checker 本体不写 trace。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` command-probe.ts D2 探测（五类标志文件 + 冲突/无标志 → null）+ index.ts 决议 + SC1 纯 import 终验

- **Affects**: `src/harness/verify/command-probe.ts`（新）, `tests/harness/verify/command-probe.test.ts`（新）;`src/harness/verify/index.ts`（**不改**，见 Rationale）
- **Acceptance**: `npx vitest run tests/harness/verify/command-probe.test.ts` 全绿（SC8）——`pyproject.toml`/`pytest.ini` → `pytest`;`package.json`（含 vitest dep）→ `npx vitest run`;`package.json`（含 jest dep）→ `npx jest`;`go.mod` → `go test ./...`;`Cargo.toml` → `cargo test`;无任何标志文件 → null（A10 fail-closed，落判官）;多标志冲突（vitest + jest 并存）→ null（不猜）;SC1 终验：`grep -n "^import" src/harness/verify/evidence-checker.ts` 输出无 `loop-engine` / `session-api` / `subagent` / `fs` 禁项（唯一跨 context import = `../model-adapter/types.js` type-only）;`npm run typecheck` + `npm run lint` 通过
- **Rationale**: command-probe 是独立纯函数文件（零 import evidence-checker），故与 T3/T4 可并行;仅依赖 T2 已创建 evidence-checker.ts 以执行 SC1 终验。index.ts 决议（计划级定稿，实证依据）: `index.ts:6-9` 注释明示「纯函数层 (verdict / inject) 是 verify-loop 内部契约, 装配层不消费, 不在此暴露」——evidence-checker / command-probe 同属纯函数层，**不加入 barrel**，index.ts 零改动，与 minimal-change-verifier 一致。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Dependency graph

```
T1 ──→ T2 ──→ T3 ──→ T4
         │
         └──→ T5 [parallel with T3, T4]（command-probe 独立文件，零共享状态）
```

- T1 → T2: 类型契约是 evidence-checker 实现的编译面前置
- T2 → T3: extractTestRuns 产物（TestRunEvidence 稳定形状）是 marker/弱绿/吞失败/时效判定的输入
- T3 → T4: CONTRADICTED/gamingSignals/fail-closed 是判定末段，依赖 T3 的 green 判定就位后的稳定语义（同文件顺序扩展，不并行）
- T2 → T5: command-probe 独立文件可与 T3/T4 并行；但 SC1 终验需 evidence-checker.ts 已存在（T2 产出）
- T5 内部先实现 command-probe 本体 + 测试，再跑 SC1 终验 grep（同 ticket 收尾）

**并行标记**: T5 [parallel with T3, T4]（不同文件、无共享可变状态，可开独立 ticket 并行;合并顺序无关）。

## Cross-references（spec SC1-SC9 → bullet 映射）

| SC  | 内容                                                                    | 落点                                                  |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| SC1 | evidence-checker.ts 纯 import（无 loop-engine/session-api/subagent/fs） | T2 创建时约束 + T5 终验 grep                          |
| SC2 | 三态 verdict + EvidenceReport 接口，无「条件计数」面                    | T1（types.ts grep）                                   |
| SC3 | 五框架 green marker 各有一用例                                          | T3（frameworks.test.ts）                              |
| SC4 | exit code 双路解析 + is_error→null                                      | T2（exit-code.test.ts）                               |
| SC5 | 三防落点 + doc-only 豁免                                                | T3（three-guards.test.ts）                            |
| SC6 | CONTRADICTED 仅二进制事实                                               | T4（contradicted.test.ts + gaming-soft.test.ts 反向） |
| SC7 | fail-closed：歧义/残缺/空输入全非 SUFFICIENT                            | T2（空输入）+ T4（fail-closed.test.ts 属性式）        |
| SC8 | D2 探测五类命中 + 无标志/冲突 → null                                    | T5（command-probe.test.ts）                           |
| SC9 | gamingSignals 只记录，verdict 不变                                      | T4（gaming-soft.test.ts 断言）                        |

- 并行面: T5 与 T3/T4 并行;T1 与 458 plan 整体并行（无共享文件，458 走 goal-lifecycle 上下文）。
- 不改清单（spec Boundaries）: `verify-loop.ts`（接线归 sibling spec）、`verdict.ts`、`classifier.ts`、`index.ts`（本 plan T5 决议）。

## 验证（plan done 的四项）

1. `cat plans/449-evidence-checker.md | grep -E "^\s*### T[0-9]"` → 5 条 tracer bullet 编号齐全
2. 实施后 `git log --oneline` → 1 commit per bullet（5 bullets = 5 commits）
3. `git diff --stat HEAD~5..HEAD` → 每 commit 的 diff scope 匹配 bullet 的 affects 行
4. 最终报告含行: `成功 = plan has 5 tracer bullets, each with binary acceptance + [implementation] tag`
