# Plan: strategy window and subagent card

**Goal:** 仓库缺省策略预算窗口 256k、proactive 闸 95%；子代理会话卡 completed 后留下任务概述并加 `✓ Done`；同一 worker 只画一张卡；过程性「等待模型」在工具相位离屏且不指控网络。
**Approach:** 只动压缩缺省与 TUI 投影。不改 `spawn_subagent` schema / handler；不停工人、不续跑（见 `plans/subagent-stop-and-continue.md`）。同轮两张卡并排是合法并行，不是本计划的去重对象；本计划去的是「已 join 卡 + 未 join 幽灵 live 行」。角色文件在 `~/.iknow/agents`，不在本仓库。过程块 live-signal、web、Ctrl+X 仍不做。
**Spec link:** `specs/tui-subagent-transcript-live.md`（完成态）；`specs/transport-continue-persist.md` 不变式 3 / SC6；压缩以 ADR-0100 + CONTEXT **策略预算窗口** / **auto-compact token gate** 为合同
**Predecessor:** `plans/tui-subagent-transcript-live.md` — 卡位置与 join 仍成立；完成态「第 2 行换成字面 `done`」由本计划 supersede。父模型停/续从本计划拆出。
**ACR:** all-yes（block below）
**待写入:** 空
**Issue:** 无（TUI 切片；停/续跑见另一计划所挂 issue）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

> Reopens `specs/tui-subagent-transcript-live.md` 锁句 2 与完成态表。不重开 ADR-0014。无 ADR 冲突。

## ACR

bounded-context-guardian: yes — 压缩只动 env / compress 推导与显示分母同源；卡与 live tail 只动 tui 投影；sticky 只动 TUI notice 相位；不改 spawn handler。
input-contract-tests: yes — 显式 `thresholdTokens >= window` 仍 throw；未设走 95%；卡 empty/join miss/failed 仍 EXIT 不绿勾；未 join 的 spawn live 行在已有 join 卡时不画。
error-handling-enforcer: yes — 阈值非法仍 typed throw；卡 join 不上 `// EXIT:` 不借预览；清 notice 只认过程性「等待模型」identity。
complexity-anti-drift: yes — 阈值仍一个推导函数；卡仍一块投影；live 去重是过滤谓词，不是第二套 Listing。
minimal-change-verifier: yes — 一任务 = 256k/95% + 卡完成态 + 同卡幽灵行 + 过程心跳离屏；不含 `subagent_stop` / `subagent_continue` / 改 wait 默认。

Affected files (enumerate, not freeze): `src/config/env.ts`, `src/harness/compress/threshold.ts`, `src/tui/hub-bridge.ts`, compress/env/hub-bridge 测试, `src/tui/subagent-message-lines.ts`, 卡宿主与 `tests/tui/subagent-card-lines.test.ts`, `docs/llm-config-quickstart.md`, `src/tui/app.tsx`, `src/tui/live-tool-preview.ts`, `tests/tui/streaming-silence-notice.test.tsx`, `tests/tui/live-tool-preview.test.tsx`, `specs/transport-continue-persist.md`。

## Locked sentences

1. `contextWindow` 默认 256000，是策略预算，不是供应商上限；显示分母与 auto-compact 闸同一数字（ADR-0100）。
2. 未设 `thresholdTokens` 时闸 = `floor(0.95 × contextWindow)`；显式值仍必须 `< window`。不再用 `window − 33k` 当缺省。
3. 省略 `subagent_type` 仍 = `general-purpose`。指定角色必须传 catalog 里已有的 id；task 正文里的 `ROLE:` 不路由。
4. 子代理卡 live：`{role} running...` + dim 任务概述。`role` = catalog id（缺省 `general-purpose`）。catalog 有该 id 且这次带了 type → 卡上就是该 id。
5. 子代理卡 completed：概述留下，其下 `✓ Done`；不得替换概述；不得再写 `running...`；failed 走 failure overlay。
6. 同一 worker：已 join 的卡与未 join 的幽灵 `running` 行不得并排。会话 map 里已有任一 spawn 卡时，live tail 丢掉没有 join 的 `spawn_subagent` 运行行。同轮两个真实 worker 两张卡合法（ADR-0101）。
7. 过程性「等待模型」只在模型相位给出；`tool_call_start`（含 spawn）立即清除已上屏文案；文案不写 Check your network。

## Tasks (ordered by dependency)

1. **Amend subagent-card spec for completed layout** — tag: `[decision]`
   - **Inherits:** CONTEXT **subagent card live**；锁句 5 failed 不走绿勾；join / 身份条拆除 / 面板不改
   - **Surface:** `specs/tui-subagent-transcript-live.md`
   - **Acceptance:** 锁句 2、完成态表、SC2 写明概述 + `✓ Done`，不再要求字面 `done` 或完成后 `running...`
   - Status: [x] done

2. **Default strategy window 256k and 95% gate** — tag: `[implementation]`
   - **Inherits:** ADR-0100；Locked sentences 1–2；显式阈值覆盖与 `< window` 硬校验不变
   - **Surface:** config env 与 compress 阈值推导；TUI/health 显示分母同源
   - **Acceptance:** 未设 env/settings 时 `contextWindow === 256000` 且未设阈值时闸为 `floor(0.95 × 256000)`；显式阈值仍优先；`threshold >= window` throw。夹具里写死 200000 的测试不改产品缺省。`npm test` 覆盖推导与默认值的用例绿
   - Status: [x] done
   - [parallel]

3. **Card keeps overview and prints ✓ Done** — tag: `[implementation]`
   - **Inherits:** T1 锁句 4–5；failed / join miss / `subagent_result` 不改
   - **Surface:** tui 子代理卡纯派生与两宿主消费
   - **Acceptance:** live 仍 running + dim 概述；completed 可见同一概述且其下绿 `✓ Done`；无 `running...`；failed 仍 overlay。既有卡投影单测按新合同改绿
   - Status: [x] done
   - [blocks: T1]
   - [parallel]

4. **Waiting-model notice leaves on tool phase** — tag: `[implementation]`
   - **Inherits:** CONTEXT **sticky notice** / **model-call idle**；`specs/transport-continue-persist.md` 不变式 3 / SC6
   - **Surface:** TUI sticky notice（`runTurnOnce` 相位门）
   - **Acceptance:** 模型相位静默可出等待文案；`tool_call_start`（含 `spawn_subagent`）后帧上不再有该文案；文案不含 Check your network；成功收尾仍清。既有相位门「工具期不新写」仍绿
   - Status: [x] done
   - [parallel]

5. **One live spawn card per worker** — tag: `[implementation]`
   - **Inherits:** T1 锁句 4、6；CONTEXT **subagent card live**
   - **Surface:** tui live tail + 卡 join map
   - **Acceptance:** 已有 join 卡时，未 join 的 `spawn_subagent` running 行不出现在 live 文本行里；无任何 join 卡时仍画第一条运行行。夹具覆盖「历史已 join + live 幽灵第二条」
   - Status: [x] done
   - [blocks: T1]

## Code review phase

整轮落地后 `code-review`；`GATE: BLOCKED` → `review-report-repair`。
