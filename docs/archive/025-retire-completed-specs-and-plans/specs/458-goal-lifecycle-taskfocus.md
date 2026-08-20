> **ARCHIVED 2026-08-20.** Superseded by `specs/verify-goal-gate.md`. Do not implement from this file.

# Spec: 458 — goal 生命周期重构：goal/taskFocus 拆分 + model_proposed 删除 + /goal 三面 + 确定性校验

> 来源：#458 map 的 G 票决议——#459（goal/taskFocus 拆分定稿）/ #461（T6 裁剪 + model_proposed 删除）/ #460（不加防注入层 + validateGoalText）/ #463（固定锚调研背书）；消费 #432（worktree-408-not-yet-specified-impl）中**裁剪后**的 T7/T8/T11/T12 素材。
> 上游 map：#458（goal 生命周期完整化 + verify 证据优先接缝）。
> 与 SPEC `449-verify-evidence-first-loop` 的关系：本 spec 产出 task 取值公式的**数据侧**（goal + taskFocus 字段与 #459 迁移），那个 spec 消费公式接线判定层；本 spec 先行（阻塞关系：公式的第二段 taskFocus 必须先存在）。
> 假设闸门：operator 已授权"自己决策、自己审完写好"（delegated assumption confirmation）。

## Glossary（exact copy from docs/CONTEXT.md + 决议新术语）

- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。
- **三态判定 (tri-state verdict)**: 验证结果判定 = pass / 真失败 / 不稳定；本 spec 的 outcome→status 映射消费它（T11）。
- **goal（会话使命，#459 术语 B）【决议新术语】**：用户显式设定的整个会话任务，agent 沿它自主探索/建设。只由 `/goal <text>` / `## GOAL: <text>` 写入（`source = user_pin`）；固定锚，模型不可写；仅 `/goal clear` 清除；re-pin 旧值进 `history` 标 `superseded`；verify-loop 终局写 `status = achieved / aborted`。分类器 task 字段第一优先来源。
- **taskFocus（任务焦点，#459 术语 A）【决议新术语】**：长上下文中模型当前该围绕什么干、compact 后仍保持焦点的确定性提取对象。系统从 user 消息确定性提取（首条 user 消息 seed，明确任务切换时更新）；`text` ≤ 500 字符、`history` 每条 ≤ 300 字符且最多 5 条（去重）；仅 compact 边界渲染一次给主模型（当前焦点截 240 + 最近 3 条历史各截 120）；模型只读不写。分类器 task 字段第二优先来源（goal 缺席时）。
- **task 取值公式【#459/#461 决议】**：`task = session.goal.text ?? session.taskFocus.text ?? query`（唯一口径；判定层只读消费、不回写）。当前 master 的 `goal.text ?? query` 是待重构过渡态，不是对齐目标。
- **validateGoalText【#460/#468 决议】**：统一确定性输入校验 = 非空 + ≤ `MAX_GOAL_CHARS = 2000`；`hub.postMessage` 的 goal directive 路径 + `/goal` slash handler 两入口统一执行；`isValidGoal` 只管持久化 shape、不追溯已落盘超长 goal。

## Architectural Constraints（ADR 引用）

- **ADR-0015**（settings single source）：本 spec 不开新配置口；taskFocus 无 settings 字段。
- **ADR-0011**（loop-engine stop semantics）：taskFocus 的 compact 边界渲染走既有 compact attachment 缝，不动 Loop Engine 停止语义。
- **ADR-0003 / ADR-0008**（trace placement / token accounting）：goal 动作落 `TraceService.recordGoal`（T12），观测真值进 JSONL，不另起账本。
- **Schema 纪律**：`CURRENT_SCHEMA_VERSION` 现为 5（explorer 实证）。加 `taskFocus` 为**可选顶层字段**——按 120-session-persistence 先例（v2 +summary/cwd、v3 +checkpoints 均为加可选字段零迁移），可选字段加入不强制 bump；是否 bump v6 列为 Ask-first（见 Boundaries）。
- **冻结契约**：`extractGoal`（只读首条 user 消息）语义不变，但其 seed 目标从 `goal` 改为 `taskFocus`（#459 迁移决议）；`/resume` 自然在场（同 session 文件载体）。

## Objective

把 #458 map 的三项概念混乱按决议落成代码：

1. **goal 语义统一（#459）**：现 `GoalState` 一字段两用（用户固定锚 vs 模型可推进活对象）→ 拆成 `session.goal`（固定锚，仅用户通道写）+ `session.taskFocus`（确定性提取的任务焦点）。旧 `goal.source === "user_initial"` 数据迁移为 `taskFocus`（那是把 A 的种子错存进了 B）；`user_pin` 保留为 `goal`。
2. **model_proposed 删除（#461）**：`GoalSource` 收缩为 `"user_initial" | "user_pin"`（`user_initial` 随迁移处理后，新写入实际只有 `user_pin`；联合中保留 `user_initial` 供迁移/读旧盘），`VALID_GOAL_SOURCES` 白名单同步删除 `model_proposed`；#432 的 T6 propose/confirm 侧通道（proposeGoal / confirmGoal / PendingGoalProposal / parseProposeGoalCommand / pendingProposal 旁路键）**整体不落地**。
3. **生命周期补全（#432 裁剪素材）**：T7 `/goal status|clear|<text>` 三面、T8 状态机转移守卫（validateGoalTransition + sanitize 接入）、T11 outcome→status 完整映射（passed→achieved / aborted→aborted / escalated→aborted / failed→active / unstable→active，master 现状只有前两态）、T12 recordGoal trace API（发射点：seed/pin/clear/writeback）。
4. **确定性校验（#460/#468 待办 1）**：`validateGoalText`（非空 + ≤ 2000）统一两入口；`/goal` handler 补长度校验（现状只查空）；hub `## GOAL:` 路径对齐。

用户：iknow 交互面使用者（chat / tui / serve）。成功 = goal 是纯用户固定锚（模型零写入路径）、taskFocus 提供 compact 存活的任务焦点、分类器 task 公式数据侧就位、两个 goal 写入入口校验一致。

## Tech Stack

不变：TypeScript + Node（ESM，tsc strict）。无新依赖。taskFocus 提取 = 确定性算法（规范化空白 + 截断），**v1 不用 LLM**（#459 排除项）。

## Commands

```bash
npm run typecheck
npm test                                        # vitest：unit + harness + integration
npx vitest run tests/session-api                # goal/taskFocus 定向
npx vitest run tests/harness/trace              # recordGoal 定向
npm run lint
```

## Project Structure

```
src/session-api/store/schema.ts    # +TaskFocusState 类型；GoalSource 收缩（删 model_proposed）；
                                   # +validateGoalText / MAX_GOAL_CHARS；sanitize：user_initial goal→taskFocus 迁移；
                                   # +validateGoalTransition（T8，#432 素材）+ history 链校验
src/session-api/goal/              # 【新】goal 子模块（#432 裁剪后素材）：只保留 T8 转移守卫纯函数
                                   #（assertValidTransition/applyTransition + VALID_GOAL_TRANSITIONS + typed errors）；
                                   # 不落 T6（proposeGoal/confirmGoal/PendingGoalProposal 整体不要）
src/session-api/hub.ts             # seedGoal→seedTaskFocus（user_initial 迁移）；pinGoal 保持；
                                   # parseGoalCommand 路径 +validateGoalText；outcome→status 映射升五态（T11）；
                                   # 落 recordGoal 发射（T12）；taskFocus compact 边界渲染接线
src/cli/slash.ts                   # /goal 三面分发（status/clear/<text>，#432 T7 素材）
src/cli/chat-session.ts            # 三面 host 处理 + validateGoalText 长度校验（#468 待办 1）
src/harness/trace/types.ts         # +GoalAction/GoalTraceStatus/GoalRecord + TraceService.recordGoal（T12，
                                   #   source 值域删 model_proposed、action 删 propose/confirm）
src/harness/trace/jsonl.ts         # recordGoal 实现（record_type: "goal"）
src/harness/trace/noop.ts          # recordGoal noop 实现
tests/session-api/                 # + goal/taskFocus/迁移/校验/转移用例
tests/harness/trace/               # + recordGoal 用例
```

**#432 素材消费策略**：worktree-408-not-yet-specified-impl 分支基线陈旧（含与 goal 无关的 -11000 行删除，且删了 verify-loop 本体）——**不整体 merge**；只把 goal 子模块 3 新文件（types/errors/index）+ T7/T8/T11/T12 接线按 #461 裁剪后重落在新 master 上。`git diff master..worktree-408-not-yet-specified-impl --stat` 中 11 个 goal 相关文件是素材清单，其余全部不碰。

## Code Style

沿用既有风格（显式 readonly 类型、纯函数优先、注释只解释 why）。关键形状：

```ts
/** #459 术语 A：确定性任务焦点。模型只读不写；v1 提取不用 LLM。 */
export interface TaskFocusState {
  readonly text: string; // ≤ 500 chars（seed/更新时截断）
  readonly updatedAt: string; // ISO 8601；未来证据时效锚点（#449 派生）
  readonly history?: ReadonlyArray<{
    readonly text: string /* ≤300 */;
    readonly updatedAt: string;
  }>; // ≤5 去重
}

/** #459/#461：GoalSource 收缩。user_initial 仅为读旧盘/迁移保留，新写入恒 user_pin。 */
export type GoalSource = "user_initial" | "user_pin";

export const MAX_GOAL_CHARS = 2000;
export function validateGoalText(text: string): string | null; // 非法返回错误描述，合法返回 null

// #459 迁移：sanitize/load 时 goal.source === "user_initial" → taskFocus.text，goal 置空
```

T11 映射（#432 hub.ts:750-802 素材，五态）：

```ts
const outcomeToStatus = {
  passed: "achieved",
  aborted: "aborted",
  escalated: "aborted",
  failed: "active",
  unstable: "active", // 保留现场以便重试/re-verify
} as const;
```

## Testing Strategy

vitest。覆盖测试规范六类：

| 层          | 内容                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常        | pin → `source: user_pin`；re-pin 旧值入 history 标 superseded；首条 user 消息 seed → `taskFocus`（非 goal）；outcome 五态映射逐态断言；`/goal status` 回显 / `clear` 置空 / `<text>` pin。                      |
| 失败        | goal 文本 > 2000 → 两入口均拒绝不落盘；非法转移（如 achieved→active）→ validateGoalTransition 拒绝；畸形 goal 对象 → `validateSessionFile` 报 `"goal"`（typed-error 渲染 `${kind}: ${conversation_id}` 契约）。 |
| 边界        | 恰好 2000 字符 → 通过；2001 → 拒绝；taskFocus text 501 字符 → 截到 500；history 第 6 条 → 挤掉最旧（cap 5）；重复焦点 → 去重不重复入 history；goal 空 text → task 公式退到 taskFocus → 再退 query。             |
| 权限        | 模型无 goal/taskFocus 写入路径（不存在 PROPOSE_GOAL 解析、无 model_proposed writer）——以"代码路径不存在"断言（grep 级 + 无 writer 测试）。                                                                      |
| 空/非法输入 | `/goal`（无参）→ usage 提示；`/goal status` 于 fresh conversation → 真 store + fresh conversationId 走 `not_found` 合法态（非错误，typed-error catch 契约）；`## GOAL:` 空 body → 忽略。                        |
| 并发/迁移   | SerializeQueue 下两次 re-pin 只有一赢；v5 旧盘（goal.source=user_initial）load → 迁成 taskFocus、goal 空；v5 旧盘（user_pin）→ 原样。                                                                           |

命令 handler 集成测试按项目规范接**真实 SessionStore（temp dir）+ fresh conversationId**，fresh 上的合法态与真实故障分开断言。

## Boundaries

- **Always do**：goal 只从用户通道写入（`/goal`、`## GOAL:`）；两入口统一过 `validateGoalText`；taskFocus 提取纯确定性（不调模型）；转移守卫在写盘前执行；每个 goal 动作落 recordGoal；测试先行。
- **Ask first**：`CURRENT_SCHEMA_VERSION` 是否 bump v6（加可选字段按先例可不 bump，但 taskFocus + goal 语义收缩同时发生，若 review 认为读侧需要版本信号则 bump）；`session.summary` 改名（#459 说"随压缩 issue 一起做"——本 spec 不做，确认维持）。
- **Never do**：落地 T6 propose/confirm 任何部分（#461 整体裁剪）；保留 `model_proposed` 于 `GoalSource`/`VALID_GOAL_SOURCES`/`GoalRecord.source`；模型输出/工具结果/文件内容写 goal 或 taskFocus 文本；taskFocus 用 LLM 摘要（v1 排除）；普通 turn 注入 taskFocus（仅 compact 边界渲染一次）；整体 merge worktree-408-not-yet-specified-impl（基线陈旧）；删改既有 goal T1-T5 测试（迁移语义变化导致的断言更新除外，须附理由）。

## Success Criteria（binary，每条映射可执行检查）

1. **GoalSource 收缩**：`model_proposed` 从 `GoalSource` / `VALID_GOAL_SOURCES` / `GoalRecord.source` 消失。**Check**: `grep -rn "model_proposed" src/`（无命中）。✅/❌
2. **taskFocus 落地**：`TaskFocusState` 类型存在、session 文件可选字段、首条 user 消息 seed 到 taskFocus 而非 goal。**Check**: `grep -n "taskFocus" src/session-api/store/schema.ts` + seed 测试断言 `goal === undefined && taskFocus.text === 首条消息`。✅/❌
3. **task 公式数据侧**：`goal.text ?? taskFocus.text ?? query` 可取值（三段都在场）。**Check**: 单测三段 fallback 逐段断言。✅/❌
4. **user_initial 迁移**：旧盘 `goal.source === "user_initial"` load 后 → `taskFocus.text` 有值、`goal === undefined`；`user_pin` 原样。**Check**: 迁移测试两条用例。✅/❌
5. **validateGoalText 两入口**：hub `## GOAL:` 路径 + `/goal` handler 均调用；> 2000 拒绝不落盘。**Check**: `grep -rn "validateGoalText" src/session-api/hub.ts src/cli/chat-session.ts`（各 ≥1）+ 超长拒绝测试。✅/❌
6. **/goal 三面**：status/clear/\<text\> 三面在 slash 分发 + host 处理就位；fresh conversation status 走 not_found 合法态。**Check**: `tests` 中三面用例 + fresh conversation 集成用例。✅/❌
7. **T8 转移守卫**：非法转移被拒（含自转移）；history 链校验接入 sanitize。**Check**: validateGoalTransition 用例（合法 5 边 + 非法样本）。✅/❌
8. **T11 五态映射**：failed/unstable→active、escalated→aborted 补上（master 现状只 passed/aborted）。**Check**: 五态参数化测试。✅/❌
9. **T12 recordGoal**：jsonl + noop 双实现；seed/pin/clear/writeback 发射点接线；GoalAction 无 propose/confirm。**Check**: `grep -n "recordGoal" src/harness/trace/jsonl.ts` + 发射点集成测试（trace 断言）。✅/❌
10. **T6 零残留**：proposeGoal/confirmGoal/PendingGoalProposal/parseProposeGoalCommand/pendingProposal 不落地。**Check**: `grep -rn "proposeGoal\|confirmGoal\|PendingGoalProposal\|PROPOSE_GOAL\|pendingProposal" src/`（无命中）。✅/❌
11. **compact 边界渲染**：taskFocus 仅在 compact 边界渲染一次（当前焦点 240 + 最近 3 条 × 120），普通 turn 不注入。**Check**: compact 集成测试断言渲染内容与次数。✅/❌

## Open Questions

- **OQ1**：`session.summary` 改名随压缩 issue（#459 明示）——本 spec 不碰，等压缩票。不阻塞。
- **OQ2**：taskFocus"明确任务切换时更新"的确定性判定算法细节（何种信号算任务切换）——spec 给最小实现（首条 seed + 用户显式切换标记），细化留 PLAN。不阻塞。
- **OQ3**：schema version bump 与否（Ask-first 项）。不阻塞。

## Assumptions（operator delegated，逐条挂外部真值）

1. **A1 goal/taskFocus 双对象拆分 + 迁移规则**（user_initial→taskFocus、user_pin 保留）——CONFIRMED by #459 Resolution。
2. **A2 task 公式唯一口径 `goal.text ?? taskFocus.text ?? query`，判定层只读不回写**——CONFIRMED by #459/#461。
3. **A3 T6 整体裁剪、model_proposed 彻底删除、不做 draft 语义**——CONFIRMED by #461 Resolution。
4. **A4 不加防注入层，只加 validateGoalText（非空 + ≤2000），isValidGoal 不追溯**——CONFIRMED by #460 Resolution + #468 待办 1。
5. **A5 #432 不整体 merge，goal 素材按 #461 裁剪后重落新 master**（worktree 基线陈旧，含 -11000 行无关删除）——CONFIRMED by explorer ground truth（git diff --stat）+ #461 派生"#462 按本决议裁剪合入范围"。
6. **A6 taskFocus v1 确定性提取不用 LLM、上限 text 500 / history 5×300、仅 compact 边界渲染**——CONFIRMED by #459 Resolution §3。
7. **A7 T11 五态映射含 failed/unstable→active、escalated→aborted**——CONFIRMED by #432 hub.ts:750-802 素材 + #458 map（T11 outcome→status 完整五态映射）。
8. **A8 T7 命令面只做 status/clear/\<text\> 三面（不做 pause/resume/gate）**——CONFIRMED by #432 PR 描述（YAGNI 收敛）。
9. **A9 本 spec 不接 verify 判定层**（公式的判定侧消费归 SPEC 449-verify-evidence-first-loop）——CONFIRMED by #461"挂起归 #449"。

→ 全部挂决议票原文或 explorer 实证，无静默假设。

## ACR Verdict（architecture-change-reviewer）

**Round 1（2026-08-16）**: `5/5 yes` → **OVERALL: PASS → hand to writing-plans**。

```
bounded-context-guardian: yes — 改动限于 session-api（store/schema.ts + 新 goal/ 子目录 + hub.ts）、cli（slash.ts + chat-session.ts）、trace 接口（types/jsonl/noop）；hub→harness 为前向依赖（hub.ts:17-21 既有），goal/→store 留在 session-api 内；trace 新增 GoalAction/GoalTraceStatus/GoalRecord 按 trace/types.ts:17-23 先例保持自包含字面量联合（不从 session-api import）。
defensive-contract-validator: yes — 测试矩阵覆盖 empty（空白 + ##GOAL: 空 body）、negative（achieved→active + 自转移拒绝，SC7）、overflow（2000/2001、taskFocus 500/501、history cap 5/第 6 条）、concurrent（SerializeQueue 双 re-pin）、exception（畸形 goal → schema_invalid、typed-error ${kind}: ${conversation_id} 契约、fresh conversation not_found 合法态 vs 真实故障分离）；2000 上限在两入口显式。
error-handling-enforcer: yes — 非法转移 GoalError{kind:"invalid_transition"}；超长经 validateGoalText 返回非 null 描述 + 显式不落盘（SC5）；畸形 goal 走 schema_invalid typed throw；T6 侧通道零残留（SC10）、空 directive no-op 有文档非静默。
complexity-anti-drift: yes — T6 全链按 Boundaries Never-do 裁剪；新抽象仅决议要求的 TaskFocusState + validateGoalText + T8 守卫 + T12 recordGoal；纯函数在 schema.ts 与 goal/，hub.ts 只加薄接线点；T11 outcomeToStatus 是数据表常量（仿 hub.ts:150-178 STORE_ERROR_MAP）；compact 渲染走既有 attachment 缝（ADR-0011）。
minimal-change-verifier: yes — 单一逻辑任务（#459/#461/#460 goal 生命周期）；verify 判定层显式移交 SPEC 449b（A9）、summary 改名移交压缩票（OQ1）、T6 整体弃（A3）；worktree 不 merge 在素材策略与 Never-do 双重明示。
```

**PLAN 阶段建议（reviewer 提出，非阻塞）**：① `goal/errors.ts` 裁剪到只留 `invalid_transition`（+ 若 validateGoalText 复用则 `empty_text`），弃 T6-only kinds（auto_rejected/timeout/confirm_mismatch）；② trace 的 GoalAction/GoalTraceStatus/GoalRecord 明写为自包含字面量联合（trace/types.ts:17-23 先例），不 import session-api；③ OQ2 的 taskFocus 切换判定确定性算法在 PLAN 定稿；④ hub.postMessage 增量保持薄接线点，不加深既有 ~280 行函数。
