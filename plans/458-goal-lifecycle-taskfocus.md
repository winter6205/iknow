# Plan: 458 — goal 生命周期重构：goal/taskFocus 拆分 + model_proposed 删除 + /goal 三面 + 确定性校验

**Goal:** 把 #458 map 的 G 票决议（#459 拆分定稿 / #461 T6 裁剪 + model_proposed 删除 / #460 validateGoalText / #463 固定锚调研背书）落成代码 — goal 是纯用户固定锚，taskFocus 是 deterministic 任务焦点；T6 模型提议/确认通道零落地；/goal 命令三面齐整（status/clear/\<text\>）；task 公式 `goal.text ?? taskFocus.text ?? query` 数据侧就位供 #449 消费。

**Architecture:** 单一逻辑任务 = session-goal 生命周期重构。改动限于 `src/session-api/{store/schema.ts, store/index.ts, hub.ts, goal/}`（新子模块）、`src/cli/{slash.ts, chat-session.ts}`、`src/harness/trace/{types.ts, jsonl.ts, noop.ts}`、`src/harness/loop-engine.ts`（compact 边界渲染缝新增可选 optional）。hub.ts 增量保持薄接线点（ACR #4 PLAN 建议）；trace 的 GoalAction/GoalTraceStatus/GoalRecord 写为自包含字面量联合，不 import session-api（ACR #2 PLAN 建议，trace/types.ts:17-23 先例）；goal/errors.ts 裁剪到只留 `invalid_transition` + `empty_text`（ACR #1 PLAN 建议，弃 T6-only kinds）。

**Tech Stack:** TypeScript + Node (ESM, tsc strict)。无新依赖。taskFocus 提取 = 确定性算法（规范化空白 + 截断），v1 不用 LLM。

**Spec link:** `specs/458-goal-lifecycle-taskfocus.md`（ACR Round 1 PASS 5/5，2026-08-16）
**前置依赖**: 无（可与 `plans/449-evidence-checker.md` 并行）。**下游**: `plans/449-verify-evidence-first-loop.md`（task 取值公式判定侧消费 `task = session.goal.text ?? session.taskFocus.text ?? query`）。
**Tracker**: GitHub（label `ready-for-agent`，native blocking via addBlockedBy；票创建留待 operator 放行）。

---

## Architecture Change Reviewer verdict

引自 spec（Round 1，2026-08-16，OVERALL: PASS → hand to writing-plans）：

```
bounded-context-guardian: yes — 改动限于 session-api（store/schema.ts + 新 goal/ 子目录 + hub.ts）、cli（slash.ts + chat-session.ts）、trace 接口（types/jsonl/noop）；hub→harness 为前向依赖（hub.ts:17-21 既有），goal/→store 留在 session-api 内；trace 新增 GoalAction/GoalTraceStatus/GoalRecord 按 trace/types.ts:17-23 先例保持自包含字面量联合（不从 session-api import）。
defensive-contract-validator: yes — 测试矩阵覆盖 empty（空白 + ##GOAL: 空 body）、negative（achieved→active + 自转移拒绝，SC7）、overflow（2000/2001、taskFocus 500/501、history cap 5/第 6 条）、concurrent（SerializeQueue 双 re-pin）、exception（畸形 goal → schema_invalid、typed-error ${kind}: ${conversation_id} 契约、fresh conversation not_found 合法态 vs 真实故障分离）；2000 上限在两入口显式。
error-handling-enforcer: yes — 非法转移 GoalError{kind:"invalid_transition"}；超长经 validateGoalText 返回非 null 描述 + 显式不落盘（SC5）；畸形 goal 走 schema_invalid typed throw；T6 侧通道零残留（SC10）、空 directive no-op 有文档非静默。
complexity-anti-drift: yes — T6 全链按 Boundaries Never-do 裁剪；新抽象仅决议要求的 TaskFocusState + validateGoalText + T8 守卫 + T12 recordGoal；纯函数在 schema.ts 与 goal/，hub.ts 只加薄接线点；T11 outcomeToStatus 是数据表常量（仿 hub.ts:150-178 STORE_ERROR_MAP）；compact 渲染走既有 attachment 缝（ADR-0011）。
minimal-change-verifier: yes — 单一逻辑任务（#459/#461/#460 goal 生命周期）；verify 判定层显式移交 SPEC 449b（A9）、summary 改名移交压缩票（OQ1）、T6 整体弃（A3）；worktree 不 merge 在素材策略与 Never-do 双重明示。
```

**PLAN 阶段建议（reviewer 提出，本 plan 已吸收）**：① `goal/errors.ts` 裁剪到只留 `invalid_transition`（+ `empty_text`，供 validateGoalText 复用）；弃 T6-only kinds（auto_rejected / timeout / confirm_mismatch）。② trace 的 GoalAction/GoalTraceStatus/GoalRecord 明写为自包含字面量联合（trace/types.ts:17-23 先例），不 import session-api。③ OQ2 taskFocus 切换判定确定性算法在本 plan 定稿（T1）。④ hub.postMessage 增量保持薄接线点（不加深既有 ~280 行函数；T5 only 在薄点加 4 个 recordGoal 发射点 + seed/pin 路径微调）。

---

## Tracer bullets

> Per-ticket loop（ADR-0012）为强制：每个 `[implementation]` bullet 的 `Per-ticket loop` 行不可省略。
> 每 bullet 默认单 commit、单 ticket branch；1 commit = 1 logical task。

### T1. `[decision]` PLAN 阶段三项定稿 — OQ2 taskFocus 切换判定 / OQ3 schema bump / errors.ts 裁剪

- **Affects**: 仅本文档定稿（不写源码）；约束被 T2 / T3 / T5 / T6 各自的 Acceptance 引用
- **Acceptance**:
  - **OQ2 定稿（taskFocus「明确任务切换时更新」确定性判定算法）**：v1 信号集 = `{ (a) 首条 user 消息 seed 触发； (b) 用户显式 `/goal clear`命令触发； (c) 用户显式`## GOAL:` directive 触发 }`。**判定条件（machine-checkable）**：在 `seedTaskFocus(current: TaskFocusState | undefined, nextText: string, now: string)` 函数中，切换 = `(current === undefined) || (nextText.trim().toLowerCase() !== current.text.trim().toLowerCase())`；切换 → `nextText` 入 history[0]（cap 5 去重），新主条目 = `{ text: nextText.slice(0, 500), updatedAt: now }`；非切换（同输入重复 seed）→ no-op。**排除信号**：模型输出 / 工具结果 / 文件内容文本**不算** taskFocus 切换（spec Boundaries Never do；SC1 grep 反向断言）。**证据需求**：T8 schema 单元测试 + T6 /goal 三面集成测试 + T7 compact 边界测试均隐含该算法；该定稿被 T2 的 `seedTaskFocus` 函数逐字承载。
  - **OQ3 定稿（schema version bump）**：**结论 = 不 bump v6**。依据：① `#120-session-persistence` v2 +summary/cwd、v3 +checkpoints 均为加可选字段零迁移先例；② `taskFocus` = optional 顶层字段（与 v3 checkpoints 同模式）；`GoalSource` 收缩（删 `model_proposed`）是 union 字面量收缩，磁盘上若残留 `model_proposed` 字面值 → `isValidGoal` 直接拒（sanitize 走 `schema_invalid` 抛出，与旧数据不兼容，但属可执行 migrate），sanitize 不静默丢弃 goal；③ 既不要求读侧版本信号，又不引入新必填字段。`CURRENT_SCHEMA_VERSION = 5` 维持原值（schema.ts:106）；v5 旧盘 load 路径走 sanitize 迁移（user_initial goal → taskFocus）由 T2 验收。
  - **`goal/errors.ts` 裁剪（ACR #1 PLAN 建议）**：union = `"invalid_transition" | "empty_text"`。T6-only `auto_rejected` / `timeout` / `confirm_mismatch` 整体不落地（A3 决议）；`empty_text` 保留供 T2 `validateGoalText` 复用（统一非法文本返回 `kind: "empty_text"`）。`Result<T>` 包装与 `ok`/`err`/`goalError` 工厂保留（assertValidTransition 调用面需要）。
- **Rationale**: 三项 PLAN 决策若留到 ticket 阶段各自决策，会跨 ticket 漂移（errors.ts 裁剪影响 T3、T6 字面量；OQ2 算法不写定则 T2 / T7 行为不可测；OQ3 bump 触发 schema.ts 大改）。一次性定稿 → 后续 bullet 引用即一致。`[decision]` bullet 自身无 commit（仅文档），T2 起的 bullet 接受其作为约束。
- **Out-of-scope (不决策)**: OQ1 `session.summary` 改名随压缩 issue（spec 明示本 spec 不碰），不在本 plan 立项。

### T2. `[implementation]` schema.ts 数据侧 — `TaskFocusState` + `GoalSource` 收缩 + `validateGoalText` + sanitize 迁移 user_initial→taskFocus + `seedTaskFocus` 纯函数

- **Affects**: `src/session-api/store/schema.ts`, `src/session-api/store/index.ts`（re-export 新符号）, `tests/session-api/store/schema.test.ts`（新字段断言）, `tests/session-api/store/sanitize.test.ts`（迁移断言）
- **Acceptance**:
  - `npm run typecheck` 通过
  - `grep -rn "model_proposed" src/` **无命中**（SC1 防回归硬验收；同时 `VALID_GOAL_SOURCES` 收缩到 `user_initial | user_pin`，`isValidGoal` 不再 whitelist `model_proposed`，旧盘 `model_proposed` sanitize 时抛 `schema_invalid` typed throw）
  - `grep -n "TaskFocusState\|taskFocus" src/session-api/store/schema.ts` 命中新增类型与 `SessionFileV1` optional `taskFocus?` 字段（SC2）
  - `export const MAX_GOAL_CHARS = 2000` + `export function validateGoalText(text: string): string | null`（非空 + ≤ 2000；非法返回错误描述，合法返回 null；SC5）
  - `export function seedTaskFocus(opts: { current: TaskFocusState | undefined; nextText: string; now: string }): TaskFocusState` 实现 T1 OQ2 算法：`(current === undefined) || normalize(nextText) !== normalize(current.text)` → 切换（nextText 入 history，cap 5 去重，新主条目）；非切换 → no-op 返回 current（同一引用，idempotent）
  - sanitize（schema.ts:269-302）新增迁移分支：load 时 `goal?.source === "user_initial"` → `taskFocus = seedTaskFocus({ current: undefined, nextText: goal.text, now: sanitized_at })`，`goal` 置 undefined（spreading 不留旧 goal 字段）；`user_pin` 原样保留
  - `tests/session-api/store/schema.test.ts` 新增：`validateGoalText("")` 返非 null；`validateGoalText("x".repeat(2000))` 返 null；`validateGoalText("x".repeat(2001))` 返非 null；`TaskFocusState.text` 截断到 500；`history` 第 6 条挤掉最旧（cap 5）；重复焦点去重不重复入 history；`isValidGoal` 对 `source: "model_proposed"` 返回 false（旧盘抛 schema_invalid）
  - `tests/session-api/store/sanitize.test.ts` 新增：v5 旧盘 `goal: { source: "user_initial", text: "X", ... }` load → sanitize 后 `goal === undefined` 且 `taskFocus.text === "X"`；`user_pin` 旧盘原样
- **Rationale**: 数据侧先行（schema 是所有上层的 SSOT）。`model_proposed` 删除会触发既有引用点编译错，把"所有引用点同步"放进该 bullet 的 Affects（grep 归零为硬验收）。sanitize 迁移与 `seedTaskFocus` 同文件同 commit（同源逻辑：迁移 = 历史 user_initial 数据走 seedTaskFocus 路径升级）。
- **Per-ticket loop**: tdd（先写 schema.test.ts + sanitize.test.ts 红测）→ typecheck+tests → code-review（standards + spec 双轴；trace/types.ts:17-23 自包含字面量联合先例对位）→ verification-before-completion（跑 schema.test.ts + sanitize.test.ts + 全量 vitest 跑过）→ commit on ticket branch

### T3. `[implementation]` `src/session-api/goal/` 子模块 — `assertValidTransition` + `applyTransition` + `VALID_GOAL_TRANSITIONS` + `invalid_transition`/`empty_text` 错误（T8 素材落地，T6 整体裁剪）

- **Affects**: `src/session-api/goal/errors.ts`（新）, `src/session-api/goal/types.ts`（新，仅含 `TransitionInput` + `VALID_GOAL_TRANSITIONS`，**不**含 `PendingGoalProposal` / `ProposeGoalInput` / `ConfirmGoalInput` / `AcceptedGoal` / `ConfirmSurface`），`src/session-api/goal/index.ts`（新，仅 `assertValidTransition` + `applyTransition` + re-export 常量，**不**含 `proposeGoal` / `confirmGoal`），`src/session-api/store/index.ts`（不 re-export goal/），`tests/session-api/goal-transition.test.ts`（新）
- **Acceptance**:
  - `npm run typecheck` 通过
  - `grep -rn "PendingGoalProposal\|proposeGoal\|confirmGoal\|parseProposeGoalCommand\|pendingProposal\|PROPOSE_GOAL" src/ tests/` **无命中**（SC10 T6 零残留硬验收）
  - `grep -rn "auto_rejected\|confirm_mismatch" src/` 无命中（ACR #1 裁剪）
  - `src/session-api/goal/types.ts` 仅含 `VALID_GOAL_TRANSITIONS = [["active","achieved"],["active","aborted"],["active","superseded"],["achieved","superseded"],["aborted","superseded"]] as const` + `TransitionInput` interface（裁剪自 worktree-408-not-yet-specified-impl/types.ts:47-61）
  - `src/session-api/goal/index.ts` 的 `assertValidTransition({ from, to })`：自转移拒 → `err(goalError("invalid_transition", "...", { from, to }))`；非白名单转移拒；合法返回 `ok(true)`（自 worktree-408-not-yet-specified-impl/index.ts:124-149 裁剪）
  - `applyTransition(goal, nextStatus, now)` 纯函数返回 `{ ...goal, status: nextStatus, updatedAt: now }`（worktree/index.ts:155-165 同）
  - `tests/session-api/goal-transition.test.ts`：合法 5 边 + 自转移拒绝 + 非白名单样本（如 `achieved→active`、`aborted→active`、`achieved→aborted` 等）全参量化断言；typed-error 渲染 `${kind}: ${conversation_id}` 契约在 hub.ts catch 处单测（不属本 bullet，T5 边界测）
- **Rationale**: spec A5 明示「#432 不整体 merge，只把 goal 子模块 3 新文件按 #461 裁剪后重落新 master」。本 bullet 是裁剪后的纯函数模块；hub 是唯一 IO 写者，本模块只产出值；与 T2 数据侧解耦（顺序：T2 schema → T3 goal/ 子模块 → T5 hub 接线）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion（grep 零残留 + goal-transition.test.ts 全绿 + 全量 vitest）→ commit on ticket branch

### T4. `[implementation]` trace 自包含字面量联合 — `GoalAction`/`GoalTraceStatus`/`GoalRecord` + `TraceService.recordGoal` + jsonl + noop 双实现（T12 数据契约落地）

- **Affects**: `src/harness/trace/types.ts`（增 `GoalAction` / `GoalTraceStatus` / `GoalRecord` interface 与 `TraceService.recordGoal` 方法签名）, `src/harness/trace/jsonl.ts`（增 `recordGoal` 实现，自包含字面量联合，**不** import session-api），`src/harness/trace/noop.ts`（增 noop 实现），`tests/harness/trace/goal-trace.test.ts`（新）
- **Acceptance**:
  - `npm run typecheck` 通过
  - `grep -n "GoalAction\|GoalTraceStatus\|GoalRecord" src/harness/trace/types.ts` 命中（spec ACR #2 PLAN 建议：自包含字面量联合不 import session-api；trace/types.ts:17-23 文件头注释先例对位）
  - `GoalAction = "seed" | "pin" | "clear" | "writeback"`；`GoalTraceStatus = "active" | "achieved" | "aborted" | "superseded" | "cleared"`（**不**含 `model_proposed`；ACR #2 + SC1 协同）
  - `GoalRecord = { readonly sessionId: string; readonly action: GoalAction; readonly status?: GoalTraceStatus; readonly text?: string; readonly textLen?: number; readonly ts: string; readonly conversationId: string }` —— 与 `VerificationRecord`（types.ts:189-206）同形态：`id` 由调用方提供 + `sessionId` 关联会话根；调用方提供 `id`，jsonl 顶层用 `goal_id` 承载（mirrors `verification_id` 在 jsonl.ts:217-222 的处理）
  - `TraceService.recordGoal(record: GoalRecord): Promise<string | undefined>`（spec 文件头注释：不 import session-api 类型；自包含字面量联合保持 trace 域独立）
  - jsonl 实现写入：`{ record_type: "goal", goal_id: record.id, conversation_id: <instance 绑定>, ...snake_case_record(record, except id) }`；`noop` 返回 `undefined`
  - `tests/harness/trace/goal-trace.test.ts`（mirrors `tests/harness/trace/verification.test.ts:48-90`）：行形状断言（record_type / goal_id / snake_case 顶层 key / conversation_id 存在 / 无重复 id 载体）；可选字段缺席（status / text / textLen） → 不写 key（Postel 字段出席纪律，与 verification.test.ts:77-90 同模式）；always-throw writer → 返回 undefined 不抛；noop 返回 undefined
- **Rationale**: trace 域独立松耦合是文件头注释明示原则（types.ts:21-23）；`VerificationRecord` 先例（types.ts:189-206 + jsonl.ts:209-230 + verification.test.ts）逐字可循。本 bullet 是 T12 数据契约落定，T5 再做 hub 4 发射点接线。
- **Per-ticket loop**: tdd（先写 goal-trace.test.ts 红测）→ typecheck+tests → code-review（standards：trace 域独立；spec：4 发射点列表预对齐）→ verification-before-completion（goal-trace.test.ts + jsonl.test.ts + verification.test.ts 全绿，无回归）→ commit on ticket branch

### T5. `[implementation]` hub.ts 薄接线点 — `seedTaskFocus` 接线 + T11 outcome→status 五态映射 + T12 recordGoal 4 发射点 + `## GOAL:` 路径 validateGoalText

- **Affects**: `src/session-api/hub.ts`（仅在 4 个薄接线点加增量，不加深既有 ~280 行函数 — ACR #4 PLAN 建议）, `src/session-api/hub.ts:106-111` 的 `parseGoalCommand` 后增加 `validateGoalText` 调用，`src/session-api/hub.ts:813-835` 的 verify-writeback 改为查 `outcomeToStatus` 表（hub.ts:150-178 `STORE_ERROR_MAP` 形态），`tests/session-api/hub-goal.test.ts`（seedTaskFocus 改断言），`tests/session-api/goal-status-writeback.test.ts`（5 态断言升级 + recordGoal trace 断言），`tests/harness/trace/integration.test.ts`（可选：扩 goal recordGoal 集成）
- **Acceptance**:
  - `npm run typecheck` 通过
  - **T11 五态映射**（SC8）：hub.ts:813-835 处 `const OUTCOME_TO_STATUS: Record<VerifyLoopOutcome, GoalStatus | undefined> = { passed: "achieved", aborted: "aborted", escalated: "aborted", failed: "active", unstable: "active", disabled: undefined } as const`（仿 hub.ts:150-178 `STORE_ERROR_MAP` 数据表常量形态；**`failed`/`unstable` 表值 = "结果保持 active"，不是转移目标**）；写回分支判定 `OUTCOME_TO_STATUS[verifyOutcome]` 非 undefined **且 ≠ `goal.status`** → 走 `applyTransition(goal, status, now)`（T3 纯函数；passed→achieved / aborted→aborted / escalated→aborted 三边，均在白名单）+ `recordGoal({ sessionId, action: "writeback", status, ts, conversationId })`；`failed`/`unstable`/`disabled`（目标 = 当前 status，即 `active→active` 自转移）→ **不走 applyTransition**（T3 拒绝自转移，`VALID_GOAL_TRANSITIONS` 不含 `active→active`），goal.status 不变但落 `recordGoal({ action: "writeback", status: "active" })`（trace 留痕）
  - **`seedGoal` 改名 → `seedTaskFocus`**：hub.ts:1072-1080 私有方法改返回 `TaskFocusState`；hub.ts:1061 处的 `extractGoal(result.messages)` seed 改写为 `taskFocus: seedTaskFocus({ current: withCheckpoint.taskFocus, nextText: extractGoal(result.messages), now })`（OQ2 算法承载点）；**不再** seed `goal` 字段（taskFocus 替代）
  - **T12 4 发射点**：
    - `seedTaskFocus` 触发处（hub.ts:1061） → `trace?.recordGoal({ sessionId: conversationId, action: "seed", textLen: <len>, ts, conversationId })`（seed 路径在 conditionalSave 内，trace 已构造）
    - `## GOAL:` pin 路径（hub.ts:607-621）→ `trace?.recordGoal({ sessionId, action: "pin", text: goalDirective.slice(0, 200), ts, conversationId })`
    - `/goal clear` 在 chat-session.ts 走时（spec T7 三面；本 bullet 仅占位 helper：hub 暴露 `clearGoal(conversationId)` 私有方法，T6 slash + chat-session 调用；此处落 `recordGoal({ action: "clear", status: "cleared" })` 发射）
    - `OUTCOME_TO_STATUS` 写回路径 → `recordGoal({ action: "writeback", status, ts, conversationId })`
  - **`## GOAL:` validateGoalText**（hub.ts:106-111 + 593-621）：`parseGoalCommand` 返回非空字符串后调 `validateGoalText(goalDirective)`；返回非 null → `throw new ValidationError(goalDirective + " rejected: " + msg, { field: "goal_text" })`（与 hub.ts:973-986 `validateText` 同形态），不落盘
  - `tests/session-api/hub-goal.test.ts` 现有 seed 断言改为：seed 后 `goal === undefined && taskFocus.text === 首条消息文本`（SC2）；既有的 user_pin goal 旧测试数据继续兼容（user_pin 路径保留 schema.ts 中字段但不再被 seed）
  - `tests/session-api/goal-status-writeback.test.ts` 既有 4 态断言升级：保留 `passed→achieved` / `aborted→aborted` / `disabled→active`；新增 `failed→active` / `unstable→active` / `escalated→aborted` 三条（SC8）；每条断言 `recordGoal` 被调用且 trace 字段对齐（用 `vi.mock` 替身 jsonl 同 verification.test.ts 模式）
- **Rationale**: hub 是数据侧 + 子模块 + trace 的**集成收口**点；ACR #4 强调薄接线。T11 数据表常量是 minimal change；T12 4 发射点 trace 落盘是 spec Objective 4 可观测性必达项。
- **Per-ticket loop**: tdd（先写 goal-status-writeback.test.ts 新增 3 条 + hub-goal.test.ts seed 改写）→ typecheck+tests → code-review（hub.ts 函数级复杂度 ≤ 10 + 嵌套 ≤ 4 + 函数 ≤ 40 行 — ACR complexity-anti-drift 守门）→ verification-before-completion（goal-status-writeback.test.ts + hub-goal.test.ts + goal-pin.test.ts + goal-seam.test.ts 全绿；trace 集成无回归）→ commit on ticket branch

### T6. `[implementation]` `/goal` 三面 — `slash.ts` dispatch 三 effect + `chat-session.ts` host 三面处理 + validateGoalText 长度校验（spec T7 + ACR #468 待办 1）

- **Affects**: `src/cli/slash.ts`（SlashEffect 扩展 `{ type: "goal"; action: "status" | "clear" | "pin"; text: string }` 三态 + `applySlashCommand` 三分支）, `src/cli/chat-session.ts`（`case "goal"` 三子分支 + `hub.clearGoal(conversationId)` 接入）, `tests/cli/goal-slash.test.ts`（新 — 三面分发单测，mirrors worktree goal-slash.test.ts 裁剪）, `tests/cli/goal-slash-runtime.test.ts`（新 — 真实 `SessionStore` temp dir + fresh `conversationId` 三面集成；typed-error catch 契约：fresh 上 `not_found` 走合法态，非错误）
- **Acceptance**:
  - `npm run typecheck` 通过
  - `tests/cli/goal-slash.test.ts`：`applySlashCommand({ command: "goal", args: [] })` 返 `{ type: "goal", action: "status" }`；`args: ["status"]` 同；`args: ["clear"]` 返 `{ type: "goal", action: "clear" }`；`args: ["X"]` 返 `{ type: "goal", action: "pin", text: "X" }`；slash 解析与 worktree-408-not-yet-specified-impl/tests/cli/goal-slash.test.ts 同形态但不含 T6-only propose/confirm 分支
  - `tests/cli/goal-slash-runtime.test.ts`（按项目测试规范 — 真实 store + fresh conversationId）：
    - happy path：fresh conversationId + `pin` → store 落盘 `goal.status === "active" && goal.text === args`（user_pin）
    - fresh conversationId + `status` → `/goal` catch `store.load` 抛 `not_found` typed → 渲染 `kind: not_found: ${conversation_id}`（合法态，**非** 错误，stderr 静默 + output 显示「未设置 goal/taskFocus」），不 crash REPL
    - fresh conversationId + `clear` → 同样走 not_found 合法态，输出「无 goal 可清」无副作用
    - 已有 conversationId + `status` → 回显当前 `goal.text`（若无 taskFocus 区分显示）+ taskFocus
    - 已有 conversationId + `clear` → `goal === undefined && taskFocus === undefined`（`clearGoal` 把两者都置空）
    - pin 超长（> 2000 字符）→ validateGoalText 返非 null → stderr 错误，不落盘（SC5）
  - `src/cli/chat-session.ts:431-491` 的 `case "goal"` 三子分支：
    - `action: "status"` → `store.load(conversationId)`；catch `not_found` → output `未设置 goal / taskFocus`（合法态）；其他 typed 错误 → stderr `${kind}: ${conversation_id}`（typed-error catch 契约）
    - `action: "clear"` → `hub.clearGoal(conversationId)`（T5 暴露）或 store 原子写 `{ ...existing, goal: undefined, taskFocus: undefined }`；recordGoal 由 hub 统一落
    - `action: "pin"` → `validateGoalText(text)` 非 null → stderr 错误不落盘；否则走现有 pinGoal 路径（chat-session.ts:466-475 同形态）+ recordGoal 由 hub 统一落
  - `/help` 文案（slash.ts:73-82）更新：`/goal <text>` → `/goal <status|clear|text>` 三面提示
- **Rationale**: T7 三面是 spec Objective 3 必达项；fresh conversationId 集成测试覆盖 typed-error 合法态与真实故障分离（ACR defensive-contract-validator + code-quality.md typed-error catch 契约）；validateGoalText 两入口校验对齐（SC5）。
- **Per-ticket loop**: tdd（先写 goal-slash.test.ts + goal-slash-runtime.test.ts 红测）→ typecheck+tests → code-review（slash.ts 函数 ≤ 40 行守门；chat-session.ts case 块嵌套 ≤ 4；ac 错误文案风格与既有一致）→ verification-before-completion（slash.ts + chat-session.ts + slash.test.ts 全绿，cross-entry-consistency 通过）→ commit on ticket branch

### T7. `[implementation]` compact 边界 taskFocus 渲染 — `LoopEngineDeps.boundaryAttachment` 可选缝 + loop-engine compactMessages 后拼接 + hub 接线（ADR-0011 compact attachment 缝接入）

- **Affects**: `src/harness/loop-engine.ts`（`LoopEngineDeps` interface 加 `readonly boundaryAttachment?: () => string | undefined`；line 717 reactive compact 与 line 1339 proactive compact 共用 helper：在 `compactMessages(state.messages)` 输出后，若 `deps.boundaryAttachment?.()` 返回非空字符串，则紧接 boundary placeholder 追加一条 user 消息承载渲染文本）, `src/harness/loop-engine.ts` 的 `compactMessages` 调用点两处统一走 helper（避免双份实现漂移）, `src/session-api/hub.ts` 构造 `runDeps` 时（hub.ts:660-672）若 `session.taskFocus` 非 undefined → 注入 `boundaryAttachment: () => renderTaskFocusBoundary(taskFocus)` helper 闭包（当前焦点截 240 + 最近 3 条历史各截 120，渲染为单 user 消息），`src/harness/loop-engine.ts` interface 加 helper 之前先确认没有反向依赖（harness 不 import session-api；renderTaskFocusBoundary 是 hub 内私有 closure）
- **Acceptance**:
  - `npm run typecheck` 通过
  - `grep -n "boundaryAttachment" src/harness/loop-engine.ts src/session-api/hub.ts` 两处命中
  - hub 内 `renderTaskFocusBoundary(taskFocus)` 输出形态：`[当前焦点 (≤240)]` + `\n---\n` + `[历史 1 (≤120)]` + ... 共 4 段；总长 cap 720 字符（防御）；返回 string 注入 compact 边界
  - loop-engine 两处 compact 调用走同一 helper `applyCompactAttachment(state, deps)`：原始 compactMessages 输出 + boundary placeholder user 消息后追加 attachment user 消息（若 deps.boundaryAttachment 返非空）；新 state.messages = `Object.freeze([...].map(freezeMessage))`（与 line 1344-1347 同 immutable 纪律）
  - **不影响停止语义**：boundaryAttachment 字段缺席 → helper 早退，行为与现 master 完全一致（byte-stable 守门）；字段在 → 仅在 compact 触发时插入 user 消息，不改变 stopReason / messages count for verifier
  - 普通 turn（非 compact）→ boundaryAttachment 不调用（断言：单测覆盖 proactive 阈值未达时 → no-op）
  - `tests/harness/compress/integration.test.ts` 扩：stub harness + `boundaryAttachment: () => "focus@now\n---\nhist1"` → 触发 proactive compact 后断言 `state.messages[0]` = placeholder、`state.messages[1]` = attachment user 消息、`state.messages[2+]` = 保留尾部；boundaryAttachment 缺席 → 仅 placeholder
  - `tests/harness/compress/integration.test.ts` 扩：reactive compact 路径同样命中（line 717 共享 helper，单测覆盖两条路径）
  - `tests/session-api/hub-taskfocus-compact.test.ts`（新）：集成真实 SessionHub + deps + 长消息（触发 proactive compact）→ 断言 attachment user 消息在 messages 内；history 截 120；焦点截 240；history cap 3 条（最近 3）
- **Rationale**: 「既有 compact attachment 缝」在 master 中字面不存在，spec 引用 ADR-0011 与系统术语 "attachment 缝"。iknow 现行 compact 路径是 `loop-engine.ts:717` + `:1339` 两处调 `compactMessages` → `[placeholder, ...kept]`。本 bullet 把这两处统一进 `applyCompactAttachment(state, deps)` helper，把 attachment 缝定义在 loop-engine 内（harness 不 import session-api），hub 侧只注入闭包（hub.ts 已知 taskFocus → 渲染文本）。零反向依赖、零新 IO、零 LLM 调用（v1 排除）、不动停止语义（ADR-0011）。SC11 单测覆盖普通 turn 不注入（OQ2 算法守门）。
- **Per-ticket loop**: tdd（先写 integration.test.ts 红测 + hub-taskfocus-compact.test.ts 红测）→ typecheck+tests → code-review（loop-engine.ts 函数 ≤ 40 行守门 + helper 提取无双份实现；harness 域独立原则无破坏）→ verification-before-completion（integration.test.ts + dual-insurance.test.ts + window.test.ts + hub-taskfocus-compact.test.ts 全绿）→ commit on ticket branch

### T8. `[implementation]` 收尾回归矩阵 — 既有 goal T1-T5 测试语义更新 + 全量 vitest + T6 零残留 grep + fresh conversationId 端到端集成

- **Affects**: `tests/session-api/goal-pin.test.ts`（断言改：seed 后无 `goal`，改断言 `taskFocus`；既有 pin 路径测试若以 `goal.source === "user_initial"` seed → 改为走 pre-existing user_pin fixture；删除「'hello ## GOAL: x' is NOT a pin directive」类测试对 goal.source 的断言，保留对 directive 行为的断言）, `tests/session-api/hub-goal.test.ts`（T5 已改写 seed 断言），`tests/session-api/goal-seam.test.ts`（既有 goal.text 为 verify-loop userText 来源断言 → 改断言 `goal.text ?? taskFocus.text ?? query` 三段 fallback：seed 仅 taskFocus 时 userText = taskFocus.text；pin goal 时 userText = goal.text；两者皆无时 userText = query）, `tests/session-api/goal-status-writeback.test.ts`（T5 已升级 5 态）, `tests/harness/trace/goal-trace.test.ts`（T4 已写）, `tests/harness/trace/integration.test.ts`（T7 已扩展）, `tests/cli/goal-slash.test.ts` + `tests/cli/goal-slash-runtime.test.ts`（T6 已写）
- **Acceptance**:
  - `npm test`（vitest unit + harness + integration）全绿
  - `npm run lint` 通过
  - `grep -rn "model_proposed\|PendingGoalProposal\|proposeGoal\|confirmGoal\|parseProposeGoalCommand\|pendingProposal\|PROPOSE_GOAL\|auto_rejected\|confirm_mismatch" src/ tests/` **全零命中**（SC1 + SC10 + ACR #1 三重联合硬验收）
  - `grep -rn "taskFocus" src/` 在 `schema.ts` / `hub.ts` / `goal/` / `tests/` 全覆盖
  - `tests/session-api/goal-pin.test.ts` / `goal-seam.test.ts` 更新后**不再**断言已删字段（`goal.source === "user_initial"` 由 seed 路径不再产生 → fixture 改为 pre-existing user_pin file）
  - `tests/session-api/` 既有 4 个 goal 测试文件全部通过；删除/替换遵循 `.claude/rules/test.md`：「不得为让构建通过而删除测试」 → 任何语义改写附 commit 正文理由（goal-pin.test.ts 的 fixture 调整理由："seed 路径改走 taskFocus，user_pin fixture 显式构造保证既有用例继续成立"）
  - `tests/session-api/_end-to-end-fresh.test.ts`（新）：端到端 fresh conversationId 走完 create → postMessage（seed taskFocus）→ `/goal status`（pin 三面）→ `/goal clear`（清空）→ postMessage（task 公式退到 query）→ 全程 typed-error 渲染契约验证（not_found 合法态 vs schema_invalid 真实故障分离）
  - `tests/session-api/_compact-integration.test.ts`（新）：长 messages 触发 reactive compact + boundaryAttachment 注入 → 断言 compact 后 attachment 消息存在 + 普通 turn 不注入（OQ2 守门）
- **Rationale**: spec Boundaries Never-do 明示「删改既有 goal T1-T5 测试（迁移语义变化导致的断言更新除外，须附理由）」。本 bullet 是收尾回归矩阵；T2-T7 已分别就位的测试在此一并回归 + T6 零残留 grep + 端到端 fresh integration。任何 goal T1-T5 测试的删改必须附 commit 正文理由（test.md 守门）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review（standards：test.md 删改守门 + spec：SC1-SC11 全覆盖检查）→ verification-before-completion（npm test 全绿 + T6 grep 全零 + cross-entry 一致）→ commit on ticket branch

---

## Dependency graph

```
T1 [decision] ──┬──→ T2 ──→ T3 ──→ T5 ──→ T8
                │           │      │
                │           │      ├──→ T4 (trace 自包含; T4 与 T5 可并行,但 T5 含 T12 接线需 T4 先)
                │           │      │
                │           │      └──→ T6 ──→ T8
                │           │
                │           └──→ T7 ──→ T8
                │
                └──→ T7 (T1 OQ2 决策是 T2 seedTaskFocus + T7 attachment 输入契约的同一真源)
```

- T1 → T2/T3/T5/T7: 三项决策定稿是后续 bullet 引用面
- T2 → T3: `TaskFocusState` 类型存在后 `goal/` 子模块的 typed-error 边界（`empty_text` 复用 validateGoalText）才有共同语义
- T2 → T5: hub 用 `seedTaskFocus` + `applyTransition`（T5 才能接线）
- T3 → T5: hub T11 写回走 `applyTransition` + `assertValidTransition` 守卫
- T4 → T5: hub T12 4 发射点需要 `recordGoal` 接口已存在
- T5 → T6: hub 暴露 `clearGoal` 后 chat-session 才能接
- T6 → T7: 三面就位后 compact 边界渲染才接 hub postMessage 路径
- T2/T3/T4/T5/T6/T7 → T8: 收尾回归矩阵

**并行标记**：

- T4 [parallel with T3]（trace 自包含字面量联合 vs goal/ 子模块无共享状态）
- T4 [parallel with T5 上半]（T4 是接口，T5 接线；但 T5 需 T4 接口已声明才能 typecheck 过；commit 顺序上 T4 先 commit）

## Cross-references（spec SC → bullet 映射）

| SC   | 描述                                                    | Bullet         |
| ---- | ------------------------------------------------------- | -------------- |
| SC1  | GoalSource 收缩 model_proposed 消失                     | T2, T8         |
| SC2  | TaskFocusState + seed 到 taskFocus                      | T2, T5, T8     |
| SC3  | task 公式 `goal.text ?? taskFocus.text ?? query` 数据侧 | T5, T8         |
| SC4  | user_initial 迁移                                       | T2, T8         |
| SC5  | validateGoalText 两入口 + >2000 拒绝                    | T2, T5, T6, T8 |
| SC6  | /goal 三面 + fresh conversation not_found 合法态        | T6, T8         |
| SC7  | T8 转移守卫（合法 5 边 + 自转移 + 非法样本）            | T3, T8         |
| SC8  | T11 五态映射                                            | T5, T8         |
| SC9  | T12 recordGoal（jsonl + noop + 4 发射点）               | T4, T5, T8     |
| SC10 | T6 零残留 grep                                          | T3, T8         |
| SC11 | compact 边界渲染（仅 compact + 普通 turn 不注入）       | T7, T8         |

## 验证（plan done 的四项）

1. `cat plans/458-goal-lifecycle-taskfocus.md | grep -E "^### T[0-9]+\."` → 8 条 tracer bullet 编号齐全（T1-T8）
2. `grep -E "\[decision\]|\[implementation\]" plans/458-goal-lifecycle-taskfocus.md` → 1 条 [decision]（T1）+ 7 条 [implementation]（T2-T8）
3. 实施后 `git log --oneline` → 1 commit per [implementation] bullet（T1 无 commit；7 commits = 7 logical tasks）
4. `git diff --stat HEAD~7..HEAD` → 每 commit 的 diff scope 匹配 bullet 的 affects 行；最终 `grep -rn "model_proposed\|PendingGoalProposal\|proposeGoal\|confirmGoal\|parseProposeGoalCommand\|pendingProposal\|PROPOSE_GOAL\|auto_rejected\|confirm_mismatch" src/ tests/` 全零

## 已确认实证修正（file:line 漂移）

- spec 引用 `hub.ts:750-802` 素材位置 → 实证 hub.ts:750-758 是 `runOutcome.result` 起点，T11 五态映射表实际落在 hub.ts:813-835（verify writeback 块）— plan 写 T5 时已对齐
- spec 引用 `trace/types.ts:17-23` 自包含字面量联合先例 → 实证为 trace/types.ts:21-23 文件头注释（「不依赖 model-adapter / tools 的类型，通过重定义字面量联合 + JSDoc 标注源文件保持 trace bounded context 的独立松耦合」）— T4 引用位置准确
- spec 引用 `STORE_ERROR_MAP` 数据表形态（hub.ts:150-178）→ 实证为 hub.ts:150-178 `STORE_ERROR_MAP: Record<SessionStoreError["kind"], StoreErrorEntry>` — T5 T11 数据表模仿形态对齐
- master `CURRENT_SCHEMA_VERSION = 5`（schema.ts:106）— T1 OQ3 不 bump 定稿锚点对齐
- master `GoalSource` union 含 `model_proposed`（schema.ts:64）— T2 收缩目标对齐
- master 无 `src/session-api/goal/` 子目录（实证：目录不存在）— T3 新建子模块起点
- master 无 `TaskFocusState` / `validateGoalText` / `MAX_GOAL_CHARS` / `recordGoal` 任何符号（实证：grep 全零命中）— T2/T4 落地起点
- `parseGoalCommand` 实证位置：hub.ts:106-111；`goalDirective !== null && goalDirective.length > 0` 路径实证：hub.ts:607-621 — T5 薄接线点锚点对齐
- verify writeback 实证位置：hub.ts:813-835（条件 `(verifyOutcome === "passed" || verifyOutcome === "aborted") && saved`）— T5 T11 升级位置对齐
- `/goal` slash handler 实证位置：chat-session.ts:431-491（仅 `text` 路径）— T6 三面扩展起点对齐
- 既有 goal T1-T5 测试实证：tests/session-api/{goal-pin,goal-seam,goal-status-writeback,hub-goal}.test.ts — T8 收尾回归锚点对齐
- ACR reviewer 5/5 PASS + 4 条 PLAN 建议 → T1 三项定稿 + T3 errors.ts 裁剪 + T4 trace 自包含 + T5 hub 薄接线 四项已分别落到对应 bullet
