# Plan: 故障恢复（FaultClass · 传输重试 · 工具环检测）

**Goal:** 失败可分类；LLM 传输瞬态在 ModelAdapter 外层有界重试；本 run 工具环在结果回模型后以 `fused` 停止，说明进下一问上下文。
**Approach:** 先落可测策略表（T1），再在 adapter 缝做有界传输重试并收窄 Gate B `retry` 词（T2），最后在 loop 做完整环检测与第八停因及消费者（T3）。三刀三 commit；文件名与 helper 拆分留给 implementer。
**Spec link:** `specs/672-fault-recovery.md`
**Tracker:** GitHub 主路径（`spec` + `ready-for-agent` + 原生 blocking）。[spec #679](https://github.com/winter6205/iknow/issues/679) · [T1 #680](https://github.com/winter6205/iknow/issues/680) · [T2 #681](https://github.com/winter6205/iknow/issues/681) · [T3 #682](https://github.com/winter6205/iknow/issues/682)。T2←T1；T3←T2。
**ACR:** all-yes（自 spec）

```
bounded-context-guardian: yes — FaultClass/重试/环检测在 harness；session-api 与 CLI 只扩 StopReason 联合；零改 verify/；不新建 controllers/services 层目录
defensive-contract-validator: yes — SC 含 empty/negative/overflow（R=5 周期）/ concurrent（wave settle 后检查）/ exception（abort、MCP fail-open）
error-handling-enforcer: yes — 传输耗尽与 fused 为 typed 停止；不抛裸 Error；MCP 不正规化 fail-open 不误杀
complexity-anti-drift: yes — 三 PR 分缝：类型表 / adapter 装饰器 / loop 检测；装饰器不进 loop 状态机
minimal-change-verifier: yes — 一逻辑任务拆三 commit（G5）；T2 不先于 T1、T3 不先于 T2；无第四刀混 compact/verify
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

**Code review phase (end of round):** 三刀都合入后对整轮 diff 跑一次 `arthurpower:code-review`（Standards + Spec），再 `verification-before-completion`。单刀 WIP commit 不重复整轮审查。

## Harvest

**Settled（implementer 不得改）：** G2 in/out 表；传输重试在 ModelAdapter 装饰器不进 loop/serve、不绑 SDK maxRetries；PromptTooLong 零传输重试（ADR-0013）；环检测 settle 后、周期 k=1..5 × R=5 且停滞才 trip；结果先回模型；LOOP_DETECTED 落盘进下一问；`fused` 追加停因；worker 当失败；零改 `src/harness/verify/`；T1→T2→T3。ADR-0029 与 CONTEXT 词已落盘。

**Open（headroom）：** 退避次数与间隔；LOOP_DETECTED 模板字面量；关检测的 settings/env 键名；调用键正规化实现；FaultClass 模块文件名。

## 待写入（persist）

（空 — ADR-0029 与 CONTEXT 已在本工作树。）

## Tasks (ordered by dependency)

1. **T1 FaultClass 策略表可测** — tag: `[implementation]`
   - **Inherits:** spec Does T1 + G2 表：闭集 `retry`/`fuse`/`none`；permission deny、verify FAIL、user cancel/timeout → none；API 429 样例 → retry；同参反复 execution_failed → fuse；不改 StopReason；不接传输重试与环检测行为。
   - **Surface:** harness
   - **Acceptance:** 上表样例有自动化 yes/no（empty/negative 至少各一）；本刀 diff 不含 loop 环检测、不含 adapter 重试循环、不含 `src/harness/verify/`。
   - Status: [x] done

2. **T2 传输重试装饰 ModelAdapter** — tag: `[implementation]`
   - **Inherits:** spec Does T2：装饰 `step`；供应商只翻译；不重试 PromptTooLong；尊重 AbortSignal；耗尽后 typed 失败不裸 `Error`；Gate B 去掉可执行面 `retry` 禁词，保留 checkpoint/cost/otel/session-api。
   - **Surface:** harness model-adapter 装配（产品入口与 worker 同一装饰语义）
   - **Acceptance:** 模拟 429 后成功只交付一次成功 step；退避中 abort 走取消语义；PromptTooLong 调用次数 = 1；含 `retry` 标识符的 harness 源文件不再因该词触发 Gate B。
   - Status: [x] done
   - [blocks: T1]

3. **T3 工具环检测与 fused 消费者** — tag: `[implementation]`
   - **Inherits:** spec Does T3 + ADR-0029：wave settle 且 tool_result 已追加后再检查；周期+停滞；bash 非 0 in；MCP 不正规化 fail-open；注入 LOOP_DETECTED 并落盘；`StopReason: fused`；worker 失败信封；CLI/session-api 联合；可关检测（默认开）。
   - **Surface:** Loop Engine、subagent worker、session-api、CLI
   - **Acceptance:** spec Success Criteria 中环检测各条 yes；`src/harness/verify/` diff 为空；`npm run typecheck` 与 spec 所列 vitest 子集 exit 0。
   - Status: [x] done
   - [blocks: T2]
