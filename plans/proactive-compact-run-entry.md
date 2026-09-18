# Plan: proactive compact at run entry

**Goal:** 历史估量已过 auto-compact token gate 时，新一次 `run()` 的第一次模型调用前就会 proactive 压缩，不把超闸上下文先送给模型。
**Approach:** 合同写清「每步 step 前都检，含 `turnCount === 0`」；loop-engine 去掉「本 run 首步跳过」的锚点语义；夹具改成用超阈 prior + 单次 completed 证明首呼前已压。不改阈值公式、策略预算缺省、用量条投影、单次模型流中途压缩、手动 `/compact`、reactive `PromptTooLong` 每 run 一次。
**Spec link:** `docs/CONTEXT.md` **auto-compact token gate** / **策略预算窗口**；ADR-0008 D6（估量只做闸）；ADR-0013（reactive 兜底）。无独立活跃 spec。
**Predecessor:** 归档 `specs/119-compression-landing.md` 把 `lastCompactTurn` 初值 0 与 `turnCount > lastCompactTurn` 写成接入点；本计划重开该接入点的**首步跳过**，不重开窗口/full_summary 路径。
**ACR:** all-yes（block below）
**待写入:** 空（T1 已写入 CONTEXT）
**Issue:** 无
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

> Contradicts archived spec 119 A2 锚点写法（`lastCompactTurn = 0` 且 `turnCount > lastCompactTurn`）— 重开因为续传 prior 的 `run()` 会在首呼原样超闸。不重开 ADR-0013 / ADR-0008。阈值数字与 ADR-0100 缺省由 `plans/strategy-window-and-subagent-card.md` 管，本计划不改。

## ACR

bounded-context-guardian: yes — 只动 loop-engine 压缩接入点与 compress 合同文案；不改 spawn / session-api 压缩 RPC / TUI 显示账本。
input-contract-tests: yes — 覆盖：prior 估量超阈 + 本 run 无 tool 续跑仍须在首呼前压；未超阈不压；压缩成功后 `lastCompactTurn` 仍防同 turn 死循环；空 messages 仍 noop。
error-handling-enforcer: yes — 压缩失败 / 窗口不变仍走既有 EXIT（不更新锚点、下一轮可再检或交 reactive）；不把失败吞成成功 step。
complexity-anti-drift: yes — 仍一处 `evaluateCompactTrigger` 接入；只改何时进入该分支，不叠第二套闸。
minimal-change-verifier: yes — 一任务 = 去掉 run 首步跳过；不含 95%/256k 缺省、不含 lastUsage 显示滞后、不含流中途压缩、不含 microcompact。

Affected files (enumerate, not freeze): `docs/CONTEXT.md`, `src/harness/loop-engine.ts`, `tests/harness/loop-engine.test.ts`, `tests/harness/compress/integration.test.ts`, `tests/session-api/hub-compact-recent-tasks.test.ts`（及任何写死「必须先 tool 续跑才检」的夹具）。

## Locked sentences

1. `deps.compress` 在场时，`run()` 每次进入 `stepWithTrace` 之前都对**当时** `state.messages` 跑 `evaluateCompactTrigger`；`turnCount === 0`（含 prior 续传）不是豁免。
2. `lastCompactTurn` 只禁止「本 turnCount 上已经成功压过」的重复扫描，不禁止「本 run 尚未 step」。成功压缩后仍把锚点设为当时 `turnCount`。
3. 未过 token 闸 → `noop`，本步照常调模型。过闸 → 先 window 或 full_summary，再 step。
4. 单次模型调用进行中不 compact。工具结果进历史之后，**下一拍** step 前再检。
5. reactive `PromptTooLong` 每 run 最多一次，语义不变。proactive 在首步开火成功后，不额外要求再 reactive。
6. 用量显示仍消费 `RunResult.lastUsage`；本计划不把条改成 step 级刷新。
7. 子代理 worker 与主会话共用 `run()`；不单独再做一套闸。

## Tasks (ordered by dependency)

1. **Lock run-entry proactive in CONTEXT** — tag: `[decision]`
   - **Inherits:** CONTEXT **auto-compact token gate**「loop-engine 每轮 step 前」；锁句 1–2、4；ADR-0008 D6 估量不进 lastUsage
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** **auto-compact token gate** 写明每个 `run()` 第一次 step 前也检；Avoid 增加「用 `turnCount === 0` 跳过 proactive」。无代码。
   - Status: [x] done

2. **Compact before the first model call of a run** — tag: `[implementation]`
   - **Inherits:** T1；锁句 1–3、5、7
   - **Surface:** harness loop-engine（proactive 接入点）
   - **Acceptance:** prior 估量 ≥ 闸、本 run 第一次 adapter 成功回复即 `completed`（无 tool）时，adapter 第一次 `step`/`stream` 看到的 messages 已是压缩后历史（或 full_summary 产物），不是超闸 prior 原样。未超阈的 prior 首呼 messages 引用/条数与压缩前一致。成功压缩后同一 `turnCount` 不因 noop 死循环。`npm test` 覆盖该接入点的既有 + 新增夹具绿
   - Status: [ ] pending
   - [blocks: T1]

3. **Retire first-step-skip fixtures** — tag: `[implementation]`
   - **Inherits:** 锁句 1；归档 119「必须续跑一拍才检」不再是产品合同
   - **Surface:** harness / session-api 压缩夹具
   - **Acceptance:** 不再存在「为触发 proactive 必须先造 N 次 tool 续跑」作为唯一路径的夹具说明或断言；超阈 prior 的短 run 足以证明开火。未改产品缺省阈值数字。
   - Status: [ ] pending
   - [blocks: T2]

## Out of scope

- 策略预算 256k / 缺省 95% 闸（另一计划 / ADR-0100）
- ContextBar / UsageChip 的 one-beat lag
- 流式生成中途估量或中止
- 工具结果体积封顶、microcompact、snip

## Code review phase

整轮落地后 `code-review`；`GATE: BLOCKED` → `review-report-repair`。
