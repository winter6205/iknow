# Plan: 128 — verify 分类器（子代理 LLM 判官，填空 command 缺失）

Spec: `specs/128-verify-classifier.md`（ACR Round 2 五维全 yes，2026-08-14）
Source: #128 验证闭环 · 本 session grilling（A1–A8 operator 确认）
Tracker: GitHub（label `ready-for-agent`，native blocking via addBlockedBy）

> 前置：`plans/128-auto-correction-loop.md`（闭环引擎本体，T1–T8 已实施）；`specs/408-session-goal.md` + PR #427（`session.goal.text` 是分类器 task 字段来源，已 merged 进本基分支）。

---

## Architecture Change Reviewer verdict

引自 spec（Round 2 复审 PASS）：

- bounded-context-guardian: yes — additions confined to `src/harness/verify/`（classifier.ts 新增 + verify-loop.ts 单分支 + types.ts 接口扩展）、`src/config/settings.ts`（ADR-0015 扩展）、`src/harness/trace/{types,noop,jsonl}.ts`（interface only）; no reverse deps.
- defensive-contract-validator: yes — 5 边界类全 anchor：empty（SC4 pass→abort 降级）/ negative+exception（SC4 schema + SC5 transport/schema→unstable）/ overflow（SC8 2000 chars）/ concurrent（边界行 classifier-abort.test.ts）; SC1-10 每条带可执行 Check.
- error-handling-enforcer: yes — ClassifierResult 三态联合 typed; 失败信封 fixed-shape; transport/schema/error→unstable; maxRounds 兜底 + in-flight abort closeout.
- complexity-anti-drift: yes — classifier.ts 单职责（spawn+parse+截断）、types.ts 仅接口扩展、verify-loop.ts 仅 1 条件分支; 6 文件 cohesive 局部改动.
- minimal-change-verifier: yes — 1 logical task（填空 SC7 transparent close）; 6 文件同 commit 可行, 无混合动机.

---

## Tracer bullets

> Per-ticket loop（ADR-0012）为强制：每个 `[implementation]` bullet 的 `Per-ticket loop` 行不可省略。

### T1. `[decision]` settings.verify.classifierModel 字段命名定稿

- **Affects**: `src/config/settings.ts`, `src/harness/verify/types.ts`
- **Acceptance**: `grep -n "classifierModel" src/config/settings.ts src/harness/verify/types.ts` 两处命中; `VerifyConfig` 增 `readonly classifierModel?: string`（A7）; `parseVerify` 增非空串校验 + merge 透传
- **Rationale**: 模型槽位是 ADR-0015 扩展;命名 `classifierModel`（Ask-first 项,PLAN 阶段定稿）。此 bullet 是纯字段声明,无行为变化,单 decision ticket 先行。

### T2. `[implementation]` classifier.ts 纯函数模块（schema 解析 + 截断 + 降级）

- **Affects**: `src/harness/verify/classifier.ts`（新）, `tests/harness/verify/classifier.test.ts`（新）
- **Acceptance**: `tests/harness/verify/classifier.test.ts` 通过——`parseClassifierResult`（合法三态解析）; `{kind:"pass", evidence:[]}` → 静默降级 abort（SC4）; missing 仅 fail 时允许（SC4）; `truncateClassifierOutput` 至 2000 chars 具名测试（SC8, 对齐 ADR-0006 精神）; schema 残缺/非法 → 返回 transport/schema 错误标记（SC5）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` verify-loop command-absent 分支 spawn 分类器

- **Affects**: `src/harness/verify/verify-loop.ts`, `tests/harness/verify/classifier-loop.test.ts`（新）
- **Acceptance**: `runVerifyLoop` 增 `runClassifierOnce` 调用（command-absent 时）; `tests/harness/verify/classifier-loop.test.ts` 断言——command 缺失 → spawn 分类器（SC1）; command 已配 → 只走命令不 spawn（SC1 反向断言, stub spy 确认 classifier 未触发）; 仅 completed 触发（SC6, stub 非 completed → 原样透传）; abort/transport/schema → unstable（SC5）; maxRounds 兜底沿用
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` buildClassifierEnvelope 信封构造器

- **Affects**: `src/harness/verify/inject.ts`, `tests/harness/verify/inject.test.ts`
- **Acceptance**: `buildClassifierEnvelope({ task, missing[], reason })` 产出 spec Code Style 示例信封; 无 command/exitCode/failed_count/signature（A8）; 固定英文标记 + `Fix the failures above...` 尾行; 测试断言信封字段齐全
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` VerificationRecord 扩展 + trace 同步

- **Affects**: `src/harness/verify/types.ts`, `src/harness/trace/types.ts`, `src/harness/trace/noop.ts`, `src/harness/trace/jsonl.ts`
- **Acceptance**: `VerificationRecord` 增 `reason?/evidence?/missing?`（classifier 分支）; noop/jsonl 同步接口扩展（tsc 通过 = 验收）; `grep -n "reason\|evidence\|missing" src/harness/trace/types.ts` 命中; 既有 command 路径记录不受影响（无回归）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T6. `[implementation]` 并发/中断边界测试 + e2e smoke

- **Affects**: `tests/harness/verify/classifier-abort.test.ts`（新）, `tests/harness/verify/classifier-sc7.test.ts`（新）, `scripts/i128-verify-classifier-real-llm.ts`（新）
- **Acceptance**: `classifier-abort.test.ts`——分类器在飞时用户 abort → 闭环 outcome=aborted, message 历史无 stale 注入（SC5 并发维度）; `classifier-sc7.test.ts`——未配 command 时闭环 ≠ 裸 run 逐字节（SC9, 对照 128 SC7 回归语义反转）; real-LLM smoke 走真 sub-agent + 真模型 + 真 bwrap（镜像 `scripts/i408-session-goal-real-llm.ts` 先例）, 观察 channel 确认分类器任务字段 = `goal.text`（SC3）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Dependency graph

```
T1 [decision] ──→ T2 ──→ T3 ──→ T4 ──→ T5 ──→ T6
```

- T1 → T2: 字段命名先定, 分类器实现引用 `classifierModel`
- T2 → T3: 分类器模块是 verify-loop 分流的依赖
- T3 → T4: 信封构造器在 verify-loop fail 分支消费
- T3 → T5: 记录字段扩展在 verify-loop 写 trace 前需定型
- T4/T5 可并行（信封与 trace 互不依赖, 均依赖 T3 的 verify-loop 分流存在）
- T6 是 end-to-end, 依赖 T2-T5 全部就位

**并行标记**: T4 [parallel with T5]（信封构造器与 trace 字段扩展无依赖）。

## 验证（plan done 的四项）

1. `cat plans/128-verify-classifier.md | grep -E "^\s*[0-9]+\."` → 6 条 tracer bullet 编号齐全
2. 实施后 `git log --oneline` → 1 commit per bullet（6 bullets = 6 commits）
3. `git diff --stat HEAD~6..HEAD` → 每 commit 的 diff scope 匹配 bullet 的 affects 行
4. 最终报告含行: `成功 = plan has 6 tracer bullets, each with binary acceptance + one [decision]|[implementation] tag`
