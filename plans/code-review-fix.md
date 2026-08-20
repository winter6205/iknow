# Plan: code-review fixes for PR #575

**Goal:** 把 standards review (commit `329a101a..a7605591`) 报出的 1 High + 5 Medium 修干净，让 PR #575 重新通过 code-review。

**Approach:** 两颗 tracer bullet。T1 单文件重构 `decideAutoGoalAfterTurn`（High, S5 complexity）；T2 收口 5 条 Medium hygiene（F2 typed-error parity + F3-F6 dedup）跨 4 个文件。每个 bullet 一个 commit，独立可回滚。

**Spec link:** `specs/verify-goal-gate.md`（行为不变，仅工艺修正）
**Source findings:** PR #575 standards-review + spec-review outputs（frozen in PR body comments / handoff notes）
**ACR:** all-yes（见下）
**Tracker:** GitHub main path — 每颗 tracer bullet 一张 issue，依赖用 native `addBlockedBy`
**Per-bullet loop:** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch
**End-of-round:** code review phase (跑 standards + spec 两轴，确认 gate PASS)

## ACR

```
bounded-context-guardian: yes — 改动只在 session-api/{goal-auto,hub,store/schema} + cli/chat-session.ts；不跨 bounded context
defensive-contract-validator: yes — T1 复用既有 goal-auto.test.ts 14 个断言；T2 通过既有 1094 个 test 反向验证
error-handling-enforcer: yes — T2 F2 修复 typed-error 渲染与 chat 路径对齐，正好对回 code-quality.md 契约
complexity-anti-drift: yes — T1 直接修 S5 cyclomatic ≤10 + 软函数 ≤40 行；T2 同时降文件大小（重复代码收敛）
minimal-change-verifier: yes — T1 仅 goal-auto.ts 单文件、T2 收口 5 条 medium 跨 4 文件但净行数应降；不引入新依赖，不改公共 API
```

## Tasks (ordered by dependency)

> **Acceptance 三层结构** (per skill optimization — 见 follow-up GH issue): spec contract = 行为/结构契约（指向 SSOT）；quantitative gate = SSOT 数字（review-aid，非 contract）；measurement tool = 怎么测。

### 1. **重构 `decideAutoGoalAfterTurn` 满足 S5 阈值** — tag: `[implementation]`

- **Inherits:** standards-review F1（`goal-auto.ts:150-241`，92 行 / 7 if-branch + 4 boolean ops ≈ cyclomatic 12；同一 `return { continueAuto, clearGoal, autoTurnsRan, idleCompletedStreak }` 字面量重复 8 处；超 S5 ≤10 cap 与软函数 ≤40 行上限）
- **Surface:** `session-api/goal-auto.ts`
- **Acceptance (三层):**
  - **Spec contract:** 函数做一件事 — 「根据 turn 信号 + 之前 goal 决策」产出下一步的 (continueAuto, clearGoal, autoTurnsRan, idleCompletedStreak) 四元组；构造路径上不允许复制多份同形字面量（指向 Fowler #2 Duplicated Code）。helper 命名由 implementer 决定。
  - **Quantitative gate (review-aid, 非 contract):**
    - 函数体行数参考 ≤40 (Clean Code Ch.3 工程折中)
    - cyclomatic complexity 参考 ≤10 (NIST SP 500-235 / McCabe 1976)
    - 同形 `return { ... }` 字面量参考 ≤1 处 (Fowler #2 dedup 量化形式)
  - **Measurement tool:**
    - 行数：`wc -l` 函数体范围
    - cyclomatic：`npx eslint --rule '{"complexity":["error",10]}' src/session-api/goal-auto.ts`
    - 字面量：`rg -c 'continueAuto' src/session-api/goal-auto.ts` 应集中在 helper 一处
  - **行为不变性（不变 contract）:** 既有 14 个 `goal-auto.test.ts` 断言全过；`npx vitest run tests/session-api tests/cli` 全绿
- **Headroom:** implementer 可选 guard-clause / decision-table / extract-method 任意形态；helper 函数命名（`makeResponse` vs `buildDecision` vs `decide()`）由 implementer 决定
- Status: [x] done — `[x] 重构 decideAutoGoalAfterTurn` (commit `439ab42f`)
- [blocks: T2]

### 2. **code-review hygiene: typed-error parity + dedup** — tag: `[implementation]`

- **Inherits:** standards-review F2-F6
  - F2 `hub.ts:254-272` typed-error 渲染与 `chat-session.ts:961-967` 不对称（违反 `code-quality.md` typed-error catch 契约）
  - F3 `goal-auto.ts:268-285 + 321-352 + 354-375` applyGoalAutoContinue / applyGoalAutoError 重复同一 pipeline (Fowler #2)
  - F4 `hub.ts:992-1208` vs `chat-session.ts:273-442` 同一 auto-loop skeleton 双副本 (Fowler #2)
  - F5 `store/schema.ts:642-669` 同一可选正整数 validator 重复 3 次 (Fowler #2)
  - F6 `goal-auto.ts:321-332` applyGoalAutoContinue opts 对象 7 字段，超 Clean Code Ch.3 「polyadic requires special justification」上限
- **Surface:** `session-api/{goal-auto,hub,store/schema}.ts` + `cli/chat-session.ts`
- **Acceptance (三层):**
  - **Spec contract:**
    - F2: hub + chat 两端走同一 typed-error 渲染出口（指向 `code-quality.md` 「typed-error catch 契约」）；render form `${kind}: ${conversation_id}` 一致
    - F3: `applyGoalAuto{C,Error}` 共享同一 active-goal pipeline (Fowler #2)
    - F4: hub + chat 共用 auto-loop skeleton (Fowler #2)
    - F5: schema validator 复用单一 helper (Fowler #2)
    - F6: applyGoalAutoContinue opts 改为 4-field （≤4 fields，指向 Clean Code + Fowler 「Introduce Parameter Object」）
  - **Quantitative gate (review-aid, 非 contract):**
    - F6 opts 字段数 ≤4 (Clean Code + ESLint max-params)
  - **Measurement tool:**
    - F3 dedup: 同一 pipeline 不再出现两次 (`rg -c 'loadSessionForAutoLoop' src/session-api/goal-auto.ts` ≤1)
    - F4 skeleton: hub + chat 各一处 `runAutoLoopSteps` 调用 (`rg 'runAutoLoopSteps' src/`)
    - F5 validator: schema.ts 三处 validator 引用同一 helper (`rg 'isOptionalPositiveIntField' src/session-api/store/schema.ts` ≥3)
    - F6 opts: TypeScript signature 直接检查
  - **行为不变性（不变 contract）:** `npx vitest run` 全量 4189+ 测试全绿（无回归）；`npm run typecheck` 零 error
- **Headroom:** implementer 可自由选 helper 命名 / 导出位置 / 类型 shape；可决定 F2 用 stderr 还是日志通道；只要 acceptance 的「行为一致 + 不引入回归」满足即可
- Status: [x] done — `[x] code-review hygiene F2-F6` (commit `122ba3f`)
- [blocks: T1]

## Out of this fix plan（挂 follow-up issue，本轮不动）

- **F7** `chat-session.ts:445-489 + hub.ts:1547-1580` 薄适配器可合成 `bindAutoLoop` 工厂 — pre-existing
- **F8** `chat-session.ts:448-455` inline 重声明 `VerifyLoopResult` 应直接 import — pre-existing
- **F9** `chat-session.ts:582-595` `processSlash` 重入 `processChatLine` — pre-existing
- **F10** `hub.ts` 1939 行（pre-existing tech-debt，本 PR +96）— 拆 `hub-verify-continuation.ts` 是独立工作
- **Spec-L1** pre-existing JSDoc `goal.text ?? taskFocus.text ?? query` 公式（not in diff）— doc cleanup ticket

## 待写入

- （无）— 本 plan 不引入 domain term 或 ADR 变更，纯工艺修正。CONTEXT.md / ADR-0024 / specs/verify-goal-gate.md 都不需更新。

## Verification（plan-level, not per-bullet）

- [ ] T1 commit 后 `npx vitest run tests/session-api/goal-auto.test.ts tests/cli/goal-auto-continue.test.ts tests/session-api/hub-auto-continue.test.ts` 全绿
- [ ] T2 commit 后 `npm run typecheck` + `npx vitest run` 全绿，无新 regression
- [ ] 跑 standards-reviewer-agent 复审：F1 / F2-F6 应转为 PASS 或 file:line 移到不可见
- [ ] spec-reviewer-agent 不需重跑（行为不变）
- [ ] `git log 329a101a..HEAD --oneline` 看到两条新 commit：`refactor(goal-auto): decideAutoGoalAfterTurn S5 compliance` + `refactor(session): code-review hygiene F2-F6`
