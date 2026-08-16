# Plan: 449b — verify 闭环重构：证据优先编排 + 补跑信封 + 证据感知只读判官（unverified 四态）

**Goal:** 把 master 现状「settings 配 command → 沙箱重跑 / command 缺失 → 判官盲查」的 A/B 二选一模型，重构为「证据优先 → 补跑 → 证据感知判官兜底」的三级判定流，并让判官拿到证据体检单、吐出四态（pass/fail/unverified/abort）、拿不准永不 PASS。
**Architecture:** 在 `runVerifyLoopBody` 的 `produceObservation` 缝（`verify-loop.ts:610`）插入三级流，编排不替换命令路径既有机制（沙箱 fence / 确认阶梯 / 趋势裁判原样冻结）；judge 升级 = `SubAgentDefinition` 携带 `evidenceContext` + `parseClassifierResult` 扩四态 + `unverified`/`abort` 直接走 unstable 停法；task 公式由 hub/chat-session 升级到 #459 公式（依赖 SPEC 458 数据侧）。
**Tech Stack:** TypeScript + Node（ESM，tsc strict）。无新依赖。判官复用既有 sub-agent 基建（SPEC 468 落地后其只读面才真实成立）。
**Spec link:** `specs/449-verify-evidence-first-loop.md`（ACR Round 1 PASS 5/5，2026-08-16）
**前置依赖**（跨 plan）：

- `plans/449-evidence-checker.md`（449a）— `checkEvidence`/`probeVerifyCommand`/`EvidenceReport` 契约生产者，B4/B5/B6 消费
- `plans/458-goal-lifecycle-taskfocus.md`（458）— `session.taskFocus` 数据侧，B6/B8 的 #459 公式第二段来源
- `plans/468-subagent-judge-tool-surface.md`（468）— 判官 worker 工具面 deny-list 落地，B6 喂入 `disallowedTools` 的事实基线 + B9 SC9 复断言的前置

本 plan 是 #449 map 实施顺序的最后一环（449a 纯函数层 → 458 数据侧 → 468 判官只读 → 449b 编排接线）。

**Tracker:** GitHub（label `ready-for-agent`，native blocking via addBlockedBy；票创建留待 operator 放行）

---

## Architecture Change Reviewer verdict

引自 spec（Round 1，2026-08-16，OVERALL PASS → hand to writing-plans）：

```
bounded-context-guardian: yes — 改动限于 src/harness/verify/（checker/probe 缝 + inject/types/barrel）+ hub.ts userText 公式 + trace 双实现；Never-do 明冻 run() 停止语义 / 命令路径沙箱·阶梯·趋势 / buildNextPriorMessages 信封模式；barrel 既有最小面先例保留。
defensive-contract-validator: yes — 测试表覆盖 5 边界类 + 并发：正常（3 子例）/ 失败（unverified/abort/CONTRADICTED）/ 边界（G3 充分不重跑、补跑 1 次上限、探测失败、compact 退化）/ 空非法（畸形判官 JSON、空 evidenceContext）/ 权限（只读工具面）/ 并发中断（补跑中 abort 无 stale closeout、每轮至多一判官串行）；命令路径回归先锁定（零删除检查）；stub runFn + trace 双轨。
error-handling-enforcer: yes — fail-open 停法：unverified/abort → outcome=unstable、零信封注入、typed reason（"unverified" vs "abort"）落 VerificationRecord；"bluffing verifier worse than none" 禁止猜 unverified 成 pass/fail；四态判官输出 + 映射表；transport/schema 降级落 abort → unstable，每路径 EXIT 有文档。
complexity-anti-drift: yes — 三级流插在单一 produceObservation 缝（verify-loop.ts:610），不动 runVerifyLoopBody 轮次/趋势/maxRounds/escalate 框架与 786-835 分发；新纯函数模块独立；soft caveat：checker 三态进 trend 评估前必须映射回闭环 Verdict（pass/true-failure/unstable）—— 已写入 Code Style。
minimal-change-verifier: yes — 1 logical task（证据优先编排），1 commit；不越界进 goal 语义（SPEC 458）/ checker 内部（SPEC 449a）/ 判官只读实现（SPEC 468）；Never-do 明排 task 重绑 / 上下文塞 task / 删命令路径测试；11 条假设全挂外部决议原文。
```

**Ground truth 核验**（与 spec file:line 漂移实测 0 处）：

- `verify-loop.ts:610` produceObservation 缝 — `const observation = await opts.produceObservation(round, current);` 命中
- `verify-loop.ts:597` completed gate — `if (current.result.stopReason !== "completed")` 命中
- `verify-loop.ts:563-688` runVerifyLoopBody — 命中
- `verify-loop.ts:317-347` decideRoundAction — 命中
- `verify-loop.ts:473-550` runClassifierOnce — 命中
- `verify-loop.ts:751-784` runClassifierLoop — 命中
- `verify-loop.ts:786-835` runVerifyLoop 入口 + 分发 — 命中
- `run-classifier-adapter.ts:23-43` JUDGE_ROLE — 命中
- `hub.ts:721-724` userText 公式 — `session.goal.text ?? query` 当前形态命中
- `hub.ts:709-745` verify 组装 — 命中
- `hub.ts:806-835` 写回 — 命中
- `chat-session.ts:242` `userText: query` — 命中

---

## 命令路径回归基线快照（master 既有测试清单，先锁后改）

以下 7 个测试文件构成命令路径（沙箱重跑 / 确认阶梯 / 趋势裁判 / 判官填空 / 信封构造 / 闭环三态 / 用户中断）的不许删改基线。B2 实施时全量快照进 git，B10 收尾用 `git diff --stat -- tests/harness/verify` 校验零删除行。

| 文件                                            | 行数 | 覆盖维度                                                                         | spec 关联     |
| ----------------------------------------------- | ---- | -------------------------------------------------------------------------------- | ------------- |
| `tests/harness/verify/verify-loop.test.ts`      | 906  | 主闭环 + completed gate + trend + maxRounds + escalate                           | ADR-0011 冻结 |
| `tests/harness/verify/verdict.test.ts`          | 268  | buildFailureSignature / confirmFailure / evaluateTrend                           | 命令路径三态  |
| `tests/harness/verify/inject.test.ts`           | 440  | buildValidationEnvelope / buildClassifierEnvelope / VALIDATION_FIXED_INSTRUCTION | 信封构造      |
| `tests/harness/verify/classifier.test.ts`       | 189  | parseClassifierResult（3 态） + truncateClassifierOutput 2000 chars              | #128 SC4/SC8  |
| `tests/harness/verify/classifier-loop.test.ts`  | 648  | runClassifierLoop + command-absent 填空                                          | #128 SC1/SC5  |
| `tests/harness/verify/classifier-sc7.test.ts`   | 356  | 透明关闭语义（runClassifier 缺席 = 裸 run 字节相等）                             | #128 SC7      |
| `tests/harness/verify/classifier-abort.test.ts` | 426  | 判官在飞时 abort → 闭环 outcome=aborted + 无 stale 注入                          | #128 SC5 并发 |

> B10 校验：`npx vitest run tests/harness/verify` 仍 exit 0；`git diff --stat -- tests/harness/verify` 既有文件无删除行；新增测试文件（SC3/SC4/SC5/SC6/SC7/SC8/SC9）落 `tests/harness/verify/three-stage-flow.test.ts`（或拆分多文件，每文件独立 import；不侵入既有 7 文件）。

---

## Tracer bullets

> Per-ticket loop（ADR-0012）为强制：每个 `[implementation]` bullet 的 `Per-ticket loop` 行不可省略。
> 命令路径既有机制（沙箱 fence / 确认阶梯 / 趋势裁判 / escalate 模式）本轮**冻结不动**；新代码只在 `produceObservation` 缝（`verify-loop.ts:610`）+ 信封构造（`inject.ts`）+ 判官入口（`run-classifier-adapter.ts`）+ task 公式（hub/chat-session）+ trace 字段（`trace/{types,jsonl,noop}.ts`）增量。
> OQ1 / OQ2 在 B1 决策 bullet 中一并定稿（plan-level decision，沿用 128 plan T1 先例）。

### B1. `[decision]` OQ1 补跑信封文案终稿 + OQ2 evidenceContext 截断上限

- **Affects**: `specs/449-verify-evidence-first-loop.md`（OQ1/OQ2 段落定稿锚）；B5 实施引用本 bullet 文案，B6 引用本 bullet 截断数值
- **Acceptance**:
  - **OQ1 终稿**（B5 实施时逐字落入 `buildEvidenceRerunEnvelope`）：
    ```
    [VERIFY: rerun needed] attempt=N/M
    You claimed completion, but the automated evidence check did not find
    real test execution in the transcript.
    Missing:
    - <reason 1>
    - <reason 2>
    Run this command and include the test framework's green-summary line in
    your next response (e.g. "5 passed" / "Tests: 5 passed"):
      <command>
    ```
    依据：spec G5-4 决议骨架「你声称完成，但缺真实测试证据 + 原因 + 请跑 <测试命令> 并展示框架通过摘要」逐字翻译；reasons 来源 = `EvidenceReport.reasons`（最多 5 条，超出截 `…N more`，避免 envelope 膨胀）；命令来源 = `config.command ?? probeVerifyCommand(...)`；`attempt=N/M` 对齐 `buildValidationEnvelope` 既有 `[VALIDATION FAILED] attempt=` 前缀语法（inbox 模式一致）。
  - **OQ2 终稿**：`evidenceContext` 注入判官前宿主侧截断上限 = `20_000` codepoints（对齐 `inject.ts:6` 既有 `DEFAULT_MAX_CHARS = 20_000` 与 ADR-0006 信封纪律）。常量落 `src/harness/verify/inject.ts` 复用 `DEFAULT_MAX_CHARS`，B6 实施时 `buildClassifierEnvelope` 走同款 `truncateExcerpt` 截断。
  - `grep -n "OQ1\|OQ2" specs/449-verify-evidence-first-loop.md` 命中本 bullet 文案段落（spec 自身更新 OQ 段为「v1 PLAN 定稿」并指向本 plan）。
- **Rationale**: plan-level decision（沿用 128 plan T1 先例），单一 ticket 定稿两个文案/数值 open question，避免后续 bullet 反复重审。B5/B6 实施时直接引用本 bullet 文案与数值，不再走 Ask-first。
- **Per-ticket loop**: tdd（不适用，无代码）→ 决议锚定 → 落 spec 段落更新 → verification-before-completion → commit on ticket branch（spec 文档级 commit）

### B2. `[implementation]` 命令路径回归基线锁定（既有测试全绿 + 清单快照入盘）

- **Affects**: `tests/harness/verify/`（仅快照 / `npx vitest run` 验证，不改任何既有文件）；`plans/449-verify-evidence-first-loop.md`（基线快照段已落在本 plan 头部）
- **Acceptance**:
  - `npx vitest run tests/harness/verify` 退出 0（master 7 文件 × 既有用例数全绿）
  - `git status --porcelain -- tests/harness/verify` 输出空（既有 7 文件零改动）
  - 既有 7 文件清单与行数与本 plan 头部快照一致（允许行数随既有维护小幅漂移，但文件名清单锁定）
  - 新增 0 文件；删除 0 文件
- **Rationale**: spec Boundary「删改命令路径既有测试 = Never do」+ SC10「既有测试全绿、零删改」双重硬约束；B2 是 B3-B9 任何改动的前置闸门。基线不绿 → 不开 B3，避免在带病基线上叠加修改掩盖回归。
- **Per-ticket loop**: tdd（N/A，验证既有）→ 跑 `npx vitest run tests/harness/verify` 记录绿基线 → code-review（确认 plan 头部快照与 git 实际一致）→ verification-before-completion → commit on ticket branch（chore(verify): lock command-path regression baseline，无代码变更仅记录基线 commit）

### B3. `[implementation]` trace 数据侧先行：VerificationRecord 扩展 evidenceVerdict / gamingSignals + reason typed union

- **Affects**: `src/harness/verify/types.ts`（`VerificationRecord` 加 `readonly evidenceVerdict?: "EVIDENCE_SUFFICIENT" | "EVIDENCE_CONTRADICTED" | "EVIDENCE_INSUFFICIENT"` 与 `readonly gamingSignals?: ReadonlyArray<string>`，reason 字段保留 `string` 但新增 `REASON_UNVERIFIED = "unverified"` / `REASON_ABORT_TYPED = "abort"` 字面常量 + `type VerifyReasonKind = "classifier" | "unverified" | "abort"` 用于判别）；`src/harness/trace/types.ts`（`VerificationRecord` 镜像扩展同三字段，保持 trace bounded context 独立松耦合纪律——文件头注释 + loop-trace.ts:17/22-23 先例）；`src/harness/trace/noop.ts`（无行为变化，typecheck 自动覆盖）；`src/harness/trace/jsonl.ts`（`toSnakeCaseRecord` 自动 snake_case 化新字段，零手工改动）；`tests/harness/verify/trace-record.test.ts`（新，双轨 assert：`createJsonlTraceService` + `createNoopTraceService` 各写一条带新字段的 record，断言 jsonl 行含 `evidence_verdict`/`gaming_signals`/`reason` 键且 noop 返回 `undefined`）
- **Acceptance**:
  - `grep -n "evidenceVerdict\|gamingSignals" src/harness/verify/types.ts src/harness/trace/types.ts` 命中（SC11）
  - `grep -n "REASON_UNVERIFIED\|REASON_ABORT_TYPED" src/harness/verify/types.ts` 命中（SC7 判别常量）
  - `npx vitest run tests/harness/verify/trace-record.test.ts` 全绿（SC11 双轨：jsonl 写盘 + noop 零副作用）
  - `npm run typecheck` 通过（trace/types.ts 与 verify/types.ts 双源同构 + noop/jsonl 实现签名扩展）
  - 既有 7 测试文件零修改（`git diff --stat -- tests/harness/verify/verify-loop.test.ts ... classifier-abort.test.ts` 0 行变化）
  - trace `VerificationRecord` 字段 Postel 落盘：可选字段仅存在时写（沿用 `delete snake.id` 同款纪律；toSnakeCaseRecord 天然支持）
- **Rationale**: SC11「trace 双轨」是 B4-B7 所有 writing/落盘动作的前置数据契约；先定型字段，后接线，落 trace 的 record 才有形状可写。reason typed union 决策：保留 `string` 字段（避免改既有解析路径），新增字面常量与判别类型，ACR 决议「typed reason 区分落盘」由 producer 写字面值 + consumer 用 `REASON_UNVERIFIED/REASON_ABORT_TYPED` 判别兑现。
- **Per-ticket loop**: tdd（先写 trace-record.test.ts 断言新字段 snake_case 落盘 + noop 零副作用）→ typecheck+tests → code-review（确认 trace 文件头先例纪律与 Postel 落盘）→ verification-before-completion → commit on ticket branch

### B4. `[implementation]` checker 接线进 produceObservation 缝（SUFFICIENT→PASS / CONTRADICTED→true-failure / INSUFFICIENT→下一级）

- **Affects**: `src/harness/verify/verify-loop.ts`（`runVerifyLoopBody` 增加 evidence-first 前级：每轮 `produceObservation` 之前先 `checkEvidence({ messages: current.result.messages, claimIndex: ... })`，三态映射到现有 `RoundObservation.verdict`：
  - `EVIDENCE_SUFFICIENT` → `{ verdict: "pass", exitCode: 0, outputText: "" }`，直接进 `decideRoundAction` 走 `{ kind: "pass", finalOutcome: "passed" }`，**不调原 produceObservation**（SC2/SC3 零判官零重跑，即便 `config.command` 已配）
  - `EVIDENCE_CONTRADICTED` → `{ verdict: "true-failure", exitCode: 1, signature: buildFailureSignature({ exitCode: 1, outputText: buildContradictedSignatureText(report.reasons), countRegex: undefined })`（signature 来自 report.reasons 归一化，命令路径同款 sign 机制原样消费）
  - `EVIDENCE_INSUFFICIENT` → 落原 `produceObservation`（判官 / 命令路径既有机制）；`buildRecord` 时把 `evidenceVerdict = "EVIDENCE_INSUFFICIENT"` 与 `gamingSignals = report.gamingSignals` 写进 VerificationRecord（trace 双实现天然落盘）
    ）；`tests/harness/verify/three-stage-flow.test.ts`（新文件，首组 case 落 SC2/SC3：evidence-first 短路）
- **Acceptance**:
  - `grep -n "checkEvidence" src/harness/verify/verify-loop.ts` 命中（SC1）
  - `npx vitest run tests/harness/verify/three-stage-flow.test.ts` 全绿（SC2/SC3）：SUFFICIENT 时 `runClassifier` spy 未被调 + `runVerify` spy 未被调 + `outcome === "passed"` + `rounds === 1`
  - SUFFICIENT + `config.command` 已配 → 仍直接 PASS 不重跑（SC3 反向断言：`runVerify` spy 调用次数 = 0）
  - 既有 `verdict.test.ts` / `verify-loop.test.ts` / `classifier-loop.test.ts` / `classifier-abort.test.ts` 零修改且全绿（命令路径冻结）
  - `npm run typecheck` 通过（`checkEvidence` 来自 `evidence-checker.ts`，`EvidenceReport` 来自 types.ts，B3 已落）
  - 接线位置明示：仅在 `produceObservation` 调用前一次证据核对，不替换 `runVerifyLoopBody` 主框架（786-835 分发 / 轮次 / trend / maxRounds / escalate 不动）
- **Rationale**: B4 是三级流编排的核心接线点；SUFFICIENT 短路 + CONTRADICTED 映射 + INSUFFICIENT 透传，三种分支共用一个 `buildRecord` 出口，让 trace 落盘与既有 `decideRoundAction` 不变；spec Boundary「run() 停止语义 / 命令路径沙箱·阶梯·趋势 / buildNextPriorMessages 模式」全部冻结。CONTRADICTED 走真失败同构处置（OQ3 v1 方向，spec 已定）。
- **Per-ticket loop**: tdd（先写 three-stage-flow.test.ts 三态接入用例）→ typecheck+tests（既有 7 文件 + 新文件全绿）→ code-review（确认 produceObservation 缝位置 + 命令路径冻结 + trace 字段 Postel 落盘）→ verification-before-completion → commit on ticket branch

### B5. `[implementation]` 补跑信封 + 1 次上限（`buildEvidenceRerunEnvelope` + `rerunAttempts` 状态）

- **Affects**: `src/harness/verify/inject.ts`（新增 `BuildEvidenceRerunEnvelopeArgs` + `buildEvidenceRerunEnvelope({ round, maxRounds, reasons, command }: ...)` 走 B1 定稿文案，`reasons` 截前 5 条 + `…N more` 后缀；`VALIDATION_FIXED_INSTRUCTION` 替换为补跑专属 instruction：`Run the command and show the test framework's green-summary line; do not claim completion until verification passes.`）；`src/harness/verify/verify-loop.ts`（`runVerifyLoopBody` 新增 `rerunAttempts: number = 0` 局部状态；INSUFFICIENT + 有可跑命令（`config.command` 或 `probeVerifyCommand` 探测结果非 null）且 `rerunAttempts < 1` 时：注入补跑信封 → 走一次 `run()` 续轮 → `rerunAttempts += 1` → 下一轮重新进 B4 证据核对；`rerunAttempts >= 1` 后落 B6 判官）；`tests/harness/verify/inject.test.ts`（既有 7 文件之一，新增 `buildEvidenceRerunEnvelope` 用例组，不删既有 case）；`tests/harness/verify/three-stage-flow.test.ts`（追加补跑轮次上限用例）
- **Acceptance**:
  - `grep -n "buildEvidenceRerunEnvelope" src/harness/verify/inject.ts src/harness/verify/verify-loop.ts` 命中（SC4）
  - `npx vitest run tests/harness/verify/inject.test.ts` 全绿（既有 0 删除 + 新用例 0 失败）
  - `npx vitest run tests/harness/verify/three-stage-flow.test.ts` 全绿：补跑 1 次后第二轮若仍 INSUFFICIENT → 落判官（不无限循环）；补跑 1 次后第二轮若 SUFFICIENT → PASS（不触发判官）
  - 补跑信封走 `buildNextPriorMessages` 既有 append-only 模式（沿用 415-421 `isValidationEnvelope` 过滤纪律，spec 冻结）；前缀用 `[VERIFY: rerun needed]` 而非 `[VALIDATION FAILED]`（区分语义：B1 定稿）
  - 1 次上限 = 局部 `rerunAttempts` 计数；不走 config 字段（沿用 spec A10 决议细化）
- **Rationale**: spec G2-3「补跑后仍不足 → 落判官」+ A10 决议细化 1 次上限；B5 是 INSUFFICIENT 与判官之间的桥，确保判官只在兜底时启用且证据体检单完整。补跑信封前缀刻意不用 `[VALIDATION FAILED]`，避开 `isValidationEnvelope` 过滤歧义（B5 收尾注入用 `[VERIFY: rerun needed]` 前缀，`buildNextPriorMessages` 不剥它 → 完整信息保留到下一轮 evidence 核对前）。
- **Per-ticket loop**: tdd（先写 inject.test.ts 新用例组 + three-stage-flow.test.ts 补跑轮次用例）→ typecheck+tests（既有 7 文件零回归）→ code-review（确认 1 次上限逻辑 + `[VERIFY: rerun needed]` 前缀决策）→ verification-before-completion → commit on ticket branch

### B6. `[implementation]` 判官升级：`SubAgentDefinition` 携带 `evidenceContext` + `buildClassifierEnvelope` 扩 evidenceContext 摘要

- **Affects**: `src/harness/verify/run-classifier-adapter.ts`（**JUDGE_ROLE 声明零改动**——spec 468 Never-do「改 JUDGE_ROLE 声明内容」+ spec 449b「JUDGE_ROLE 声明不变」；判官如何消费 evidenceContext 由 `buildClassifierEnvelope` 的 instruction 段表达，不进 systemPrompt；`createRunClassifierFromManager` 新增可选 `evidenceContext?: EvidenceContext` 入参 → 进 `def.task` 拼接（**task 字段不重绑**：userText 公式走 `options.userText` 原样，evidenceContext 作为 JSON 段 append 到 task 末尾，与 spec Code Style `userText: session.goal?.text || session.taskFocus?.text || query` 兼容）；`src/harness/verify/inject.ts`（`buildClassifierEnvelope` 签名追加 `evidenceContext?: EvidenceContext`，`evidenceSummary` 字段走 `truncateExcerpt(20_000)` 落底——B1 OQ2 截断；missing + reason 段后插入 `evidence_context:` 段）；`src/harness/verify/types.ts`（`EvidenceContext` 接口按 spec Code Style 形状定型：`checkerVerdict / reasons / executedCommands / rerunAttempted / evidenceSummary`）；`src/harness/verify/verify-loop.ts`（`runClassifierLoop` 调整 `produceObservation` 闭包：调 `checkEvidence` + `probeVerifyCommand` 拿 `EvidenceReport`，组装 `EvidenceContext` 后喂入 `runClassifierOnce`；`runClassifierOnce` 签名追加 `evidenceContext?: EvidenceContext`）；`tests/harness/verify/judge-input.test.ts`（新文件，断言 envelope.task 含 `evidenceContext` JSON 段且首段 = `userText` 公式原样——SC6）
- **Acceptance**:
  - `grep -n "EvidenceContext" src/harness/verify/types.ts src/harness/verify/inject.ts src/harness/verify/run-classifier-adapter.ts` 命中（SC6 证据体检单形状）
  - `npx vitest run tests/harness/verify/judge-input.test.ts` 全绿：envelope.task 首段 = `userText` 原样不重绑（SC6），evidenceContext 字段齐全且 evidenceSummary 截到 20000 codepoints
  - `npx vitest run tests/harness/verify/inject.test.ts` 全绿（既有 + buildClassifierEnvelope evidenceContext 扩段）
  - `npx vitest run tests/harness/verify/three-stage-flow.test.ts` 全绿（INSUFFICIENT 落判官时 evidenceContext 非空，evidenceVerdict = "EVIDENCE_INSUFFICIENT" 落 trace）
  - `npm run typecheck` 通过
  - JUDGE_ROLE 声明工具面零变化（`disallowedTools` 5 项原样——B9 SC9 复断言；468 落地后实际工具面才与声明面相等）
- **Rationale**: spec G5-3 决议「task 不重绑，上下文走 evidenceContext」由 envelope 拼接顺序保证：userText 在前作判官"任务陈述"、evidenceContext JSON 段在后作"体检单"。判官从单段 task 文本升级到 task + context 二段，但 task 字段语义（用户问的是什么）未变。`evidenceContext.executedCommands` 来源 = `EvidenceReport.runs.map(r => r.command)`；`rerunAttempted` = `rerunAttempts >= 1`。
- **Per-ticket loop**: tdd（先写 judge-input.test.ts 任务字段不重绑 + evidenceContext 形状 + 截断上限用例）→ typecheck+tests → code-review（确认 task 拼接顺序 + 截断上限生效）→ verification-before-completion → commit on ticket branch

### B7. `[implementation]` 判官四态解析 + unverified/abort 停法（`parseClassifierResult` 扩四态 + `runClassifierOnce` Verdict 映射 + `runVerifyLoopBody` 失败处置）

- **Affects**: `src/harness/verify/types.ts`（`ClassifierResult` 加 `kind: "unverified"`，与现有 `pass / fail / abort` 并列；`RunClassifierFn` 入参结构不变，由 B6 envelope 携带 evidenceContext）；`src/harness/verify/classifier.ts`（`parseClassifierResult` 新增 `o.kind === "unverified"` 分支：要求非空 `reason` 字符串 + evidence 数组允许缺省（不强制，与 abort 一致）；非法 kind 仍走 abort 降级）；`src/harness/verify/verify-loop.ts`（`runClassifierOnce` 四态映射表：
  - `parsed.kind === "pass"` → `{ verdict: "pass", exitCode: 0, ... }`（既有）
  - `parsed.kind === "fail"` → `{ verdict: "true-failure", ..., reason, missing, evidence }`（既有）
  - `parsed.kind === "unverified"` → `{ verdict: "unstable", exitCode: 1, signature: "classifier-unverified", outputText: "", reason: REASON_UNVERIFIED }`（SC7/SC8 停法，**不注入信封**）
  - `parsed.kind === "abort"`（含 transport/schema 降级）→ `{ verdict: "unstable", exitCode: 1, signature: "classifier-abort", outputText: "", reason: REASON_ABORT_TYPED }`（SC7/SC8 停法，**不注入信封**）
    ）；`src/harness/verify/verify-loop.ts`（`buildRecord` 把 `reason: REASON_UNVERIFIED|REASON_ABORT_TYPED` 落 VerificationRecord——B3 typed union 消费）；`tests/harness/verify/classifier.test.ts`（既有 7 文件之一，扩 `parseClassifierResult` 四态用例组，不删既有 case）；`tests/harness/verify/three-stage-flow.test.ts`（追加 unverified/abort 停法 + reason 区分落盘 + 不注入信封三组用例）
- **Acceptance**:
  - `grep -n "unverified" src/harness/verify/types.ts` 命中 `ClassifierResult` 联合 + `REASON_UNVERIFIED` 常量（SC7）
  - `npx vitest run tests/harness/verify/classifier.test.ts` 全绿（既有 3 态 0 回归 + 新增 1 态全绿）
  - `npx vitest run tests/harness/verify/three-stage-flow.test.ts` 全绿：判官 unverified → `outcome === "unstable"` + `records[0].reason === "unverified"` + 0 信封注入（用 `priorMessages` spy 断言）；判官 abort 同款 + `reason === "abort"`；判官 pass → outcome=passed + 0 reason 字段
  - 既有 `verify-loop.test.ts` / `classifier-loop.test.ts` / `classifier-sc7.test.ts` / `classifier-abort.test.ts` 零修改且全绿（命令路径冻结 + 既有判官 3 态用例零回归）
  - `npm run typecheck` 通过（`parseClassifierResult` 返回类型扩四态，`runClassifierOnce` 消费侧窄化无漏）
- **Rationale**: spec G5-1 决议「判官加 unverified 第 4 态，与 abort 严格区分」由 B3 typed union + B7 解析/映射双层兑现；G5-2「unverified 映射 unstable 不注入信封」由 `runClassifierOnce` 直接返 `verdict: "unstable"` + `decideRoundAction` 走 `{ kind: "stop", finalOutcome: "unstable" }` 路径自然兑现（无信封注入发生在 `buildFailureEnvelope` 之外——`decideRoundAction` 只在 `kind: "continue"` 调它）。ACR error-handling-enforcer「typed reason 区分落盘」由 B3 字面常量 + B7 producer 写入双锁。
- **Per-ticket loop**: tdd（先扩 classifier.test.ts 四态 + three-stage-flow.test.ts 停法）→ typecheck+tests → code-review（确认映射表与 EXIT 文档）→ verification-before-completion → commit on ticket branch

### B8. `[implementation]` hub.ts + chat-session.ts userText 升级 #459 公式（`goal.text ?? taskFocus.text ?? query`）

- **Affects**: `src/session-api/hub.ts:721-724`（`userText` 公式改为：`session.goal !== undefined && session.goal.text.length > 0 ? session.goal.text : session.taskFocus !== undefined && session.taskFocus.text.length > 0 ? session.taskFocus.text : query`；`session.taskFocus` 来自 SPEC 458 数据侧落地后的 `SessionFileV1` 顶层可选字段）；`src/cli/chat-session.ts:242`（`userText: query` 改为同款三段 fallback，session 读自 `ctx.state.sessionFile` 或 hub 镜像——具体来源由 458 落地形态定，沿用 hub 公式即可）；`tests/session-api/hub.test.ts`（既有测试，追加 taskFocus fallback 用例，不删既有 case——若既有 test 文件未覆盖 userText 公式则新建 `tests/session-api/user-text-formula.test.ts`）；`tests/cli/chat-session.test.ts`（既有测试，追加同款 fallback 用例）
- **Acceptance**:
  - `grep -n "taskFocus" src/session-api/hub.ts src/cli/chat-session.ts` 命中（SC5）
  - `npx vitest run tests/session-api` 全绿：goal 存在 → userText = goal.text；goal 缺席 + taskFocus 存在 → userText = taskFocus.text；两者都缺席 → userText = query
  - `npx vitest run tests/cli` 全绿（chat-session 端同款）
  - 既有 7 文件 `tests/harness/verify/*` 零修改（hub 改动不动 verify 域）
  - `npm run typecheck` 通过（`session.taskFocus` 来自 458 spec 落地的类型扩展）
- **Rationale**: spec SC5 显式要求 #459 公式两端（hub + chat-session）双接线；B8 是 449b 编排的最后一段数据接入。task 公式 = 判定层只读消费，与 B6 判官 envelope.task 首段 = `options.userText`（hub 算出后透传）链路一致——B6 引用 `userText` 不变，B8 改 hub 算 `userText` 的公式，环闭合。
- **Per-ticket loop**: tdd（先写 fallback 三段测试，无 goal + 有 taskFocus → taskFocus；无 goal + 无 taskFocus → query）→ typecheck+tests → code-review（确认公式与 458 落地形态一致）→ verification-before-completion → commit on ticket branch

### B9. `[implementation]` 三级流集成测试（stub runFn + stub 判官 + trace 双轨）+ 只读判官复断言（SC9）+ 补跑中 abort 无 stale 信封

- **Affects**: `tests/harness/verify/three-stage-flow.test.ts`（追加：SC9 只读判官复断言用例 + 补跑中 abort 无 stale 信封用例 + 命令路径既有机制冻结复跑用例；stub `runClassifier` 暴露收到的 `def` 验证 `disallowedTools` 含 5 项禁工具——SC9；stub `runFn` 跑补跑轮时触发 `opts.signal.aborted = true` 验证 `outcome === "aborted"` + `priorMessages` 不残留补跑信封）；`src/harness/verify/verify-loop.ts`（如 SC9 复断言需要 `runClassifier` 入参透出 `def` 给 spy，则把 `RunClassifierFn` 既有 `disallowedTools` 字段通过 `options.config.classifierModel` 旁路注入——本 bullet 阶段确认 stub spy 可直接读取 `def`，不需改生产 seam）；`scripts/i449b-verify-three-stage-real-llm.ts`（新，real-LLM smoke 镜像 `scripts/i128-verify-classifier-real-llm.ts` 先例，stub-vitest 之外的真实 e2e 证据；触发条件 = push 前本地显式跑）
- **Acceptance**:
  - `npx vitest run tests/harness/verify/three-stage-flow.test.ts` 全绿（含 B4-B8 全部用例 + SC9 stub 判官 spy 断言 5 项禁工具 + 补跑中 abort 用例）
  - SC9 stub 用例：`runClassifier` spy 收到的 def 序列化后 `disallowedTools` 数组 === 既有 JUDGE_ROLE 声明（5 项原样保留：bash / edit_file / write_file / web_fetch / web_search）
  - 补跑中 abort 用例：`runFn` 在收到补跑信封后的 run 调用 spy 触发 `signal.aborted` → 闭环 `outcome === "aborted"` + 后续无 `run()` 调用（无 stale 信封）——沿用 `classifier-abort.test.ts` 既有模式
  - 命令路径既有机制冻结复跑：SUFFICIENT 时 `runVerify` spy 0 调用 + `runClassifier` spy 0 调用（SC2/SC3 反向断言）
  - `npm run typecheck` + `npm run lint` 通过
  - `tests/harness/verify/` 目录既有 7 文件零删除行（`git diff --stat -- tests/harness/verify/{verify-loop,verdict,inject,classifier,classifier-loop,classifier-sc7,classifier-abort}.test.ts` 输出 0 行变化）
- **Rationale**: SC9（只读判官）依赖 468 worker 工具面裁剪的代码层落地（生产）；B9 在 stub 层复断言声明面完整保留 + 显式文档化"实际工具面 = 468 负责"。补跑中 abort 边界沿用 `classifier-abort.test.ts` 既有模式（B9 不重新发明 closeout 模式，只复用）。real-LLM smoke 镜像 128 先例，本地 push 前显式触发，不入 CI 默认。
- **Per-ticket loop**: tdd（先写 SC9 stub spy + 补跑中 abort + 命令路径冻结三组用例）→ typecheck+tests → code-review（确认 spy 路径与 468 声明面 + 命令路径冻结）→ verification-before-completion → commit on ticket branch

### B10. `[implementation]` 收尾：SC1-SC11 全量核对 + 既有测试零删除行（SC10）

- **Affects**: `specs/449-verify-evidence-first-loop.md`（OQ 段更新为「v1 PLAN 定稿」（B1 引用））；`plans/449-verify-evidence-first-loop.md`（本文件「Cross-references」段补 SC1-SC11 → bullet 映射表与跨 plan blocks 图，定稿版）；**不改任何业务代码**——本 bullet 是 evidence 收集 + plan 文档收尾，非实施
- **Acceptance**:
  - SC1 三级流接线：`grep -n "checkEvidence" src/harness/verify/verify-loop.ts` + three-stage-flow.test.ts 命中（✅ B4）
  - SC2 SUFFICIENT 零成本 PASS：three-stage-flow.test.ts 断言判官 spawn 计数 = 0 且 outcome=passed（✅ B4）
  - SC3 配 command 不重跑：three-stage-flow.test.ts 断言 sandbox 执行计数 = 0（✅ B4）
  - SC4 补跑信封：grep 命中 buildEvidenceRerunEnvelope + 补跑轮次上限用例（✅ B5）
  - SC5 task 公式接线：grep 命中 taskFocus + 三段 fallback 集成用例（✅ B8）
  - SC6 判官输入升级：judge-input.test.ts 断言 envelope 含 evidenceContext 且 task = 公式原样（✅ B6）
  - SC7 判官四态：grep 命中 unverified + 四态参数化用例（✅ B7）
  - SC8 unverified/abort 停法：three-stage-flow.test.ts 断言无信封注入 + outcome=unstable + reason 字段（✅ B7）
  - SC9 只读判官：three-stage-flow.test.ts stub 断言 5 项禁工具声明完整（✅ B9；468 实际工具面落地不在本 plan）
  - SC10 命令路径回归：既有 7 文件零删除行（`git diff --stat -- tests/harness/verify` 输出无 `-N,M` 删除行）+ `npx vitest run tests/harness/verify` exit 0（✅ B2 基线 + B3-B9 实施全程冻结）
  - SC11 trace 双轨：grep 命中 evidenceVerdict/gamingSignals + trace-record.test.ts 双实现用例（✅ B3）
  - `git log --oneline HEAD~N..HEAD` 中本 plan 10 bullet = 10 commit（1 decision + 9 implementation），每 commit diff scope 与 bullet affects 行匹配
  - `npx vitest run tests/harness/verify` 终态 exit 0
- **Rationale**: B10 是 plan 闭环证据收集 + 文档定稿，**不实施代码改动**；把 SC1-SC11 二元 ✅/❌ 收口到 git 实证 + grep 实证 + 测试实证三路，避免 B1-B9 各自 claim 完成后到 plan-level 才发现某 SC 漏验。spec OQ 段更新为「v1 PLAN 定稿」= B1 决议的 spec 镜像落锚。
- **Per-ticket loop**: tdd（不适用，本 bullet 全为验证）→ 跑 SC1-SC11 全量 grep + 测试 + git diff 收集证据 → code-review（核对证据齐全）→ verification-before-completion → commit on ticket branch（docs(verify): 449b plan closure + spec OQ1/OQ2 定稿镜像）

---

## Dependency graph

```
B1 [decision] ──→ B5 (引用 OQ1 文案) ──→ B6 (引用 OQ2 截断) ──→ B7 ──→ B9
              └─→ B6                                                                ↑
B2 (基线锁) ──→ B3 ──→ B4 ──→ B5                                              ┘
                  ↑     │
                  │     └─→ B6 ──→ B7 ──→ B9 ──→ B10
                  │                                                    ↑
                  └── [parallel with B8]                          B10 收口
B8 ────────────────────────────────────────────────────────────────┘
```

- B1 → B5：OQ1 文案被 `buildEvidenceRerunEnvelope` 实施引用
- B1 → B6：OQ2 截断值被 `buildClassifierEnvelope.evidenceSummary` 截断上限引用
- B2 → B3-B9：基线不绿不开 B3
- B3 → B4：trace 字段扩展是 `buildRecord` 写 record 的前置
- B4 → B5：checker 三态映射是补跑判定的输入
- B4 → B6：`EvidenceReport` 是 `evidenceContext` 字段的数据源
- B5 → B6：补跑 1 次上限后 `rerunAttempted` 标志喂入 evidenceContext
- B6 → B7：envelope task 拼接是四态解析的输入
- B6 → B9：SC9 spy 复用 B6 暴露的 def 路径
- B7 → B9：unverified/abort 停法是 SC9 集成测试的输入
- B8 → B9：userText 公式是集成测试 fixture 的输入
- B3-B9 → B10：全量 SC1-SC11 验证

**并行标记**：

- B3 [parallel with B8]（trace 字段扩展与 hub/chat-session 公式改动无共享文件，跨 plan 依赖解耦）
- B5 + B8 [sequential but no shared files]（补跑信封走 verify/，userText 公式走 session-api/cli，可开不同 worktree 并行开发，合并顺序无关）

**串行锁**：

- B4 → B5 → B6 → B7 严格串行（同一文件 `verify-loop.ts` 多次扩展，串行提交避免同文件并行冲突）
- B9 严格在 B4-B8 之后（集成测试全栈依赖）
- B10 严格在 B1-B9 之后（plan 收口）

---

## Cross-references

### SC1-SC11 → bullet 映射表

| SC   | 内容                                                                 | 落点                       | 状态                                                                                                             |
| ---- | -------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| SC1  | 三级流接线：produceObservation 缝调 `checkEvidence`                  | B4                         | ✅（`grep -n "checkEvidence" src/harness/verify/verify-loop.ts`）                                                |
| SC2  | SUFFICIENT 零成本 PASS                                               | B4                         | ✅（three-stage-flow.test.ts SUFFICIENT 用例）                                                                   |
| SC3  | 配 command 不重跑（G3）                                              | B4                         | ✅（three-stage-flow.test.ts 配置 command + SUFFICIENT 用例）                                                    |
| SC4  | 补跑信封 + 1 次上限                                                  | B5                         | ✅（inject.test.ts 扩 buildEvidenceRerunEnvelope + three-stage-flow.test.ts 轮次上限）                           |
| SC5  | task 公式接线（hub + chat-session）                                  | B8                         | ✅（`grep -n "taskFocus" hub.ts chat-session.ts` + 三段 fallback 集成）                                          |
| SC6  | 判官输入升级（evidenceContext + task 不重绑）                        | B6                         | ✅（judge-input.test.ts envelope.task 拼接顺序断言）                                                             |
| SC7  | 判官四态：unverified ≠ abort 落盘                                    | B7                         | ✅（`grep -n "unverified" types.ts` + classifier.test.ts 扩四态）                                                |
| SC8  | unverified/abort 停法（不注入信封 + outcome=unstable）               | B7                         | ✅（three-stage-flow.test.ts stop + reason 字段）                                                                |
| SC9  | 只读判官（声明面 5 项禁工具保留）                                    | B9                         | ✅（three-stage-flow.test.ts SC9 stub spy；468 实际工具面裁剪落地在 `plans/468-subagent-judge-tool-surface.md`） |
| SC10 | 命令路径回归（既有测试全绿 + 零删改）                                | B2 + B3-B9 冻结 + B10 收口 | ✅（既有 7 文件 `git diff --stat` 0 行变化 + `npx vitest run tests/harness/verify` exit 0）                      |
| SC11 | trace 双轨（jsonl + noop + trace-based assert + no-trace deepEqual） | B3                         | ✅（`grep -n "evidenceVerdict\|gamingSignals" trace/types.ts` + trace-record.test.ts 双实现）                    |

### 实施收口证据（B10 实测，2026-08-16）

> B10 对 SC1-SC11 逐条实测收口（grep 实证 + 测试实证 + git 实证三路）；下表 file:line 为实施后真值。

| SC   | 实测证据                                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC1  | `src/harness/verify/verify-loop.ts:35,827` — `import { checkEvidence }` + body 前级调用（commit `8021fbf4`）                                                                                                                                                                       |
| SC2  | `three-stage-flow.test.ts:382` "零判官零重跑直接 PASS"：`classifierCalls().length === 0` + `outcome === "passed"`（commit `8021fbf4`）                                                                                                                                             |
| SC3  | `three-stage-flow.test.ts:410` "SUFFICIENT + config.command 已配：runVerify spy 0 调用 (SC3 反向断言)"（commit `8021fbf4`）+ `:1432` 入口级重申（commit `bfe655b3`）                                                                                                               |
| SC4  | `src/harness/verify/inject.ts:183` `buildEvidenceRerunEnvelope` + `inject.test.ts` 9 用例（逐字文案/截断/append-only）+ `three-stage-flow.test.ts:600` 轮次上限（commit `7585bd35`）                                                                                               |
| SC5  | `src/session-api/hub.ts` + `src/cli/chat-session.ts:207-208` 三段 fallback（`goal.text ?? taskFocus.text ?? query`）+ `tests/cli/chat-session-user-text.test.ts` 8 用例 + `goal-seam.test.ts` 3 用例（commit `30cd7d92`）                                                          |
| SC6  | `judge-input.test.ts`（def.task 首段 = userText + JSON 段 parse-back）+ `three-stage-flow.test.ts:831` spy 收 evidenceContext（commit `9bc9861f`）；e2e smoke 实测判官 task 二段（commit `bfe655b3` 脚本，真实跑通 result=pass）                                                   |
| SC7  | `src/harness/verify/types.ts:49,132`（unverified 变体 + REASON_UNVERIFIED）+ `classifier.ts` 四态解析 + `classifier.test.ts` +5 用例（commit `8286a284`）                                                                                                                          |
| SC8  | `three-stage-flow.test.ts:1015,1076,1111,1135` — unverified/abort/schema 降级/transport 错四组停法：outcome=unstable + reason 区分落盘 + 0 信封注入（commit `8286a284`）                                                                                                           |
| SC9  | `three-stage-flow.test.ts:1291` 集成层复断言 disallowedTools 5 项原样 + systemPrompt 零 evidenceContext 泄漏（commit `bfe655b3`）；实际工具面裁剪 = 468 plan 职责                                                                                                                  |
| SC10 | frozen 7 文件中 5 个零改动（verify-loop/verdict/classifier-loop/classifier-sc7/classifier-abort.test.ts）；classifier.test.ts +43 行追加、inject.test.ts +335 行追加（既有 case 零删除，plan 冻结条款明示允许）；`npx vitest run tests/harness/verify` = 17 文件 / 249 用例 exit 0 |
| SC11 | `src/harness/trace/types.ts:214-216` 镜像字段 + `trace-record.test.ts` 9 用例（jsonl snake_case 落盘 + noop 零副作用 + Postel 缺席省略）（commit `61ef3a42`）                                                                                                                      |

**Commit 链**（master `faa6429b` 之上，1 bullet = 1 commit）：

| Commit        | Bullet | 内容                                                            |
| ------------- | ------ | --------------------------------------------------------------- |
| `66e18c17`    | B2     | 命令路径回归基线锁定（空 commit + 行数快照；基线 191 用例全绿） |
| `30cd7d92`    | B8     | userText #459 公式（hub + chat-session）                        |
| `61ef3a42`    | B3     | trace 数据侧 evidenceVerdict/gamingSignals + reason typed union |
| `1c5ae4c3`    | B1     | spec OQ1/OQ2 定稿镜像                                           |
| `8021fbf4`    | B4     | evidence-first 前级接线（三态映射）                             |
| `7585bd35`    | B5     | 补跑信封 + 1 次上限                                             |
| `9bc9861f`    | B6     | 判官 evidenceContext 输入升级                                   |
| `8286a284`    | B7     | 判官四态解析 + unverified/abort 停法                            |
| `bfe655b3`    | B9     | 三级流集成收口 + real-LLM smoke 脚本                            |
| （本 commit） | B10    | 本收口段 + 文件清单修正                                         |

**实施过程 leader 裁决记录**（plan 未预见、实施中裁决的边界）：

1. **补跑是判官路径专属机制**（B5）：spec Code Style 伪代码 `(config.command || probed)` 若按字面实施会让命令路径 frozen 基线（`verify-loop.test.ts` 纯文本 fixture → INSUFFICIENT → 补跑轮 → rounds/records 断言全破）与 SC10/Never-do 直接矛盾。裁决：`deriveRerunCommand` 在 `config.command` 非空时返回 null（命令路径沙箱重跑是 frozen legacy，补跑信封冗余）；命令空时走 `probeVerifyCommand` 探测。SC3/SC4/SC10 同时满足。
2. **evidenceContext 不进 systemPrompt**（B6）：plan 修改文件清单原写"JUDGE_ROLE 扩 systemPrompt 段"，与 spec 468/449b「JUDGE_ROLE 声明不变」+ A6「上下文走 evidenceContext」冲突。裁决：JUDGE_ROLE 声明零改动（systemPrompt/disallowedTools 逐字节），evidenceContext 经 `buildJudgeTask` append 到 `def.task` 第二段。
3. **unverified 轮 evidenceVerdict 并存**（B7）：判官只在 INSUFFICIENT 分支被调，B4 合并的 `evidenceVerdict=EVIDENCE_INSUFFICIENT` 与判官 `reason=unverified` 在 record 中并存（两字段各自真实），不断言 evidenceVerdict 缺席。
4. **CLI 测试 1 行断言更新**（B6）：`tests/cli/process-chat-line-verify.test.ts:221` 断言 `task === "research a topic"` 被 B6 二段 task 正当取代，更新为 `task.split("\n")[0]` 断言（保持原意图：判官收到用户原问句）。
5. **real-LLM smoke 实测跑通**（B9）：本环境 LLM key 可解析，smoke 一次跑通 result=pass（SC6 task 二段 + SC10 verdict 落盘 + outcome=unstable + 判官 spawn 1 次），超越 plan"交付脚本"预期，产出真实 e2e 证据。
6. **补跑信封纳入 injected-envelope 过滤集**（B5，code-review spec 轴补充记录）：plan B5 acceptance 原文"`buildNextPriorMessages` 不剥它（`[VERIFY: rerun needed]`）→ 完整信息保留到下一轮"。实施把 `isValidationEnvelope` 改名 `isInjectedEnvelope` 并把 `[VERIFY: rerun needed]` 加入 `INJECTED_ENVELOPE_PREFIXES`（`verify-loop.ts:456`）——补跑信封在 round 3+ 被滤除。两处行为都有理由（不剥 → 下一轮 evidence 核对看到它；剥 → 防 stale 累积），但 plan 文字只陈述了前者。行为与 spec 的 stale-envelope 纪律一致，此处补录为第 6 条裁决以保证 plan 级可审计性。

**后续 ticket**（本轮 code-review 非阻断项，均不属 449b 范围）：

- **449c（原定 verify 闭环观测面板）顺带挂**：`runVerifyLoopBody` 圈复杂度 ≈14-15（S5 硬闸 10，B4 前既有 ~11 + 本轮三态映射叠加；ACR 已注 soft caveat）、`verify-loop.ts` 1148 行（S5 REVIEW 软阈值 500）——拆 `evidence-gate.ts` 纯函数模块；`runClassifierLoop` 共享 `lastEvidenceContext` 在 SUFFICIENT/CONTRADICTED 短路轮残留过期值（Medium，当前无触发路径——buildFailureEnvelope 只在 continue 轮消费，short-circuit 轮不进 continue，但防御性清空更稳）；`buildJudgeTask` 未对 `evidenceSummary` 套 OQ2 20k 截断（与 buildClassifierEnvelope 不一致，Medium，runs 累积可能撑爆判官 task）；`PROBE_FLAG_FILES` 与 command-probe.ts `FLAG_FILE_COMMANDS` keys 重复（SSOT 违反，Medium，改法=从 command-probe 导出复用）。
- **468 plan 落地时**：JUDGE_ROLE systemPrompt 加 `unverified` 到允许态清单（当前判官 prompt 只教 abort，四态中的 unverified 在生产不可达——parse 层已就绪，等 468 改 prompt 即可通达）。

**code-review gate**（终审，Standards + Spec 双轴）：

- Spec 轴：0 High / 0 Medium / 6 Low（SC1-SC11 全实测通过；Low 含 compact fixture 可选项、smoke 输出未入库等 traceability 项）。
- Standards 轴：1 High / 6 Medium / 4 Low。High（`runVerifyLoopBody` 圈复杂度）裁为**误报**——S5 阈值 10 硬闸、B4 前函数已 ~11、ACR 已注 soft caveat、本质是"改既有超标函数"非新增违规；处置 = 不阻断本轮 + 挂 449c ticket。6 Medium 全部非阻断（共享变量防御性清空 / SSOT 去重 / OQ2 截断对齐 / typed-error catch / 文件长度）→ 挂 449c。4 Low 信息级。
- **GATE: PASS**（High 误报降级 + Medium 挂 ticket + 全部 SC1-SC11 满足）。

### 跨 plan blocks 图

```
[449a evidence-checker]
  T1 types → T2 evidence-checker 骨架 → T3 框架+三防 → T4 CONTRADICTED+软信号
                                                              │
                                                              ▼
[468 subagent-judge-tool-surface]                          B4 三级流接线
  worker deny-list 裁剪（工具面落地）                         │
       │                                                     ▼
       └─────────────────────────────────────→  B6 判官升级 ──→ B7 判官四态 ──→ B9 集成 + 只读复断言
                                                              │
                                                              ▼
[458 goal-lifecycle-taskfocus]                            B8 userText 公式
  session.taskFocus 数据侧                                    │
       │                                                     ▼
       └──────────────────→  B6 喂入 #459 公式原样 ──→  B9 集成 #459 公式路径
                                                              │
                                                              ▼
                                                         B10 SC1-SC11 收口
```

**本 plan 子弹 blocks 关系**：

- B4 [blocks: `plans/449-evidence-checker.md` T2-T4] — `checkEvidence`/`EvidenceReport` 契约
- B6 [blocks: `plans/449-evidence-checker.md` T2-T4] — `EvidenceReport` 喂入 evidenceContext 字段
- B6 [blocks: `plans/468-subagent-judge-tool-surface.md`] — SC9 stub 复断言前 468 实际工具面落地（449b 在 SC9 集成层做"声明面完整保留"复断言；声明面 = 实际面相等性由 468 担保）
- B6 [blocks: `plans/458-goal-lifecycle-taskfocus.md` taskFocus bullet] — `userText` 公式第二段 `taskFocus.text` 来源
- B8 [blocks: `plans/458-goal-lifecycle-taskfocus.md` taskFocus bullet] — 同上

**本 plan 提供给下游**（本 plan 落地后解除的阻塞）：

- 449c/#463（待定）：verify 闭环观测面板（若存在）— 消费 B3 `evidenceVerdict`/`gamingSignals` 字段
- 后续 goal 任务完成度自评（若存在）— 消费 B6 evidenceContext 结构

### 并行面标注

- B3 [parallel with B8]：trace 字段扩展（`trace/{types,jsonl,noop}.ts` + `verify/types.ts`）与 hub/chat-session userText 公式（`session-api/hub.ts` + `cli/chat-session.ts`）无共享文件，可开不同 worktree 并行开发
- B5 + B8 [parallel cross-tree]：补跑信封走 `verify/`，userText 公式走 `session-api/` + `cli/`，文件集合完全无交集；可同 session 内开 worktree 并行
- B6 + B8 [parallel cross-tree] 但 B6 [blocks: B8 的前置 458 plan]：B6 的 evidenceContext 引用 `userText` 是参数透传（不重新算），B6 实施时假定 458 已落地；B8 实施时也假定 458 已落地——两者实施顺序无关但都依赖 458 plan 先于本 plan 落地

### 文件结构落地清单

**新增文件**（实施后存在）：

- `src/harness/verify/evidence-checker.ts`（449a 产出，B4-B7 消费）
- `src/harness/verify/command-probe.ts`（449a 产出，B4-B7 消费）
- `tests/harness/verify/evidence-checker/*.test.ts`（449a 产出，5 文件）
- `tests/harness/verify/command-probe.test.ts`（449a 产出）
- `tests/harness/verify/trace-record.test.ts`（B3 产出，trace 双轨）
- `tests/harness/verify/three-stage-flow.test.ts`（B4-B9 产出，三级流集成 + SC9 + 补跑 abort）
- `tests/harness/verify/judge-input.test.ts`（B6 产出，task 不重绑 + evidenceContext）
- `scripts/i449b-verify-three-stage-real-llm.ts`（B9 产出，real-LLM smoke 镜像 128 先例）

**修改文件**（既有路径增量）：

- `src/harness/verify/types.ts`（B3 扩 evidenceVerdict/gamingSignals/reason typed union）
- `src/harness/verify/verify-loop.ts`（B4 produceObservation 缝 + B5 rerunAttempts + B6 判官 evidenceContext + B7 四态映射）
- `src/harness/verify/inject.ts`（B5 buildEvidenceRerunEnvelope + B6 buildClassifierEnvelope 扩 evidenceSummary）
- `src/harness/verify/classifier.ts`（B7 parseClassifierResult 扩 unverified 态）
- `src/harness/verify/run-classifier-adapter.ts`（B6 evidenceContext 入参 + buildJudgeTask task 二段拼接；**JUDGE_ROLE 声明零改动**——systemPrompt/disallowedTools 逐字节未动，B10 裁决记录第 2 条）
- `src/harness/trace/types.ts`（B3 镜像扩展）
- `src/session-api/hub.ts`（B8 userText 公式升级到 #459）
- `src/cli/chat-session.ts`（B8 userText 公式升级到 #459）

**冻结文件**（既有路径零改动）：

- `tests/harness/verify/verify-loop.test.ts`（命令路径主闭环测试，906 行）
- `tests/harness/verify/verdict.test.ts`（闭环三态 + 趋势，268 行）
- `tests/harness/verify/inject.test.ts`（既有 case 保留，仅 B5/B6 追加，440 行基线）
- `tests/harness/verify/classifier.test.ts`（既有 3 态 case 保留，仅 B7 扩 unverified，189 行基线）
- `tests/harness/verify/classifier-loop.test.ts`（648 行）
- `tests/harness/verify/classifier-sc7.test.ts`（356 行）
- `tests/harness/verify/classifier-abort.test.ts`（426 行）
- `src/harness/verify/verdict.ts`（既有闭环三态/趋势，不改）
- `src/harness/verify/sandbox-run.ts`（既有沙箱执行体，不改）
- `src/harness/verify/index.ts`（barrel 最小面，不改；449a 决议 + 449b 同款 449a 决定不增 barrel，证据见 `index.ts:6-9` 注释）

---

## 验证（plan done 的四项）

1. `cat plans/449-verify-evidence-first-loop.md | grep -E "^### B[0-9]+"` → 10 条 tracer bullet 编号齐全
2. 实施后 `git log --oneline` → 1 commit per bullet（10 bullets = 10 commits）
3. `git diff --stat HEAD~10..HEAD` → 每 commit 的 diff scope 匹配 bullet 的 affects 行
4. 最终报告含行: `成功 = plan has 10 tracer bullets, each with binary acceptance + 1 [decision] (B1) + 9 [implementation] (B2-B10) tags`
