# Plan: 两套判断逻辑模块（HITL vs `/goal` 自动模式）

> HITL compact 保焦：本 plan 里的 `taskFocus` 条款已被 `specs/recent-user-tasks.md` / ADR-0026 覆盖。verify 两套逻辑仍以本 plan 为准。

**Goal:** 默认聊天走 HITL（不请 LLM 评做完没）；`/goal` 走自动循环（成功也评、`task` 仅 goal.text）；compact 保焦见任务摘录 spec。
**Approach:** 先关掉 HITL 完成向判官并改焦点 seed，证明问候不再请判官；再接自动模式信封（含去完整 iknow 灵魂）；最后接续跑与三档停法。本 plan 拍死 spec 留给 plan 的两项：空转 = 连续 3 个 `completed` 且该轮无 `tool_use`；`/goal` 可选 `--max-turns <正整数>`，省略则无硬顶。TUI drain A+B、command 沙箱闭环、checker 纯函数不在本 plan。CONTEXT / ADR-0024 已 persist，本 plan 不写文档。
**Spec link:** `specs/verify-goal-gate.md`
**ACR:** all-yes（见下）
**Tracker:** GitHub main path — 每颗 tracer bullet 一张 `ready-for-agent` issue，依赖用 native `addBlockedBy`
**Per-bullet loop:** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch
**End-of-round:** code review phase (the implementing environment picks the skill)

## ACR

```
bounded-context-guardian: yes — 门禁留在 harness/verify；goal/taskFocus 仍由 session-api 持有；CLI/hub 只改分派与 seed，不把 session 模型搬进 verify
defensive-contract-validator: yes — Success Criteria 已覆盖 empty / negative / overflow / concurrent / exception
error-handling-enforcer: yes — HITL 跳过完成向判官与 load 失败为命名 EXIT；禁止空 catch fail-open 到 query；Impossible/空转/不可恢复错误三档 EXIT 分离；不新增 StopReason
complexity-anti-drift: yes — 两套逻辑模块分派，禁止合并成一条 ?? 链；seedTaskFocus 保持写入器、信号外置
minimal-change-verifier: yes — 1 个逻辑任务（模式分派 + 信封 + 焦点信号）；不混入 TUI drain A+B、command 沙箱闭环、空转数字与 slash 字面量
```

## Tasks (ordered by dependency)

1. **HITL 关闭完成向 LLM，焦点只 seed 一次** — tag: `[implementation]`
   - **Inherits:** spec Does：无 taskFocus 不进判断；硬失败打回模型；SUFFICIENT/说不清不请完成向 LLM；`completed` 只表示本轮说完；无 goal 不得 fail-open 到 `query`；寒暄不 seed，像样任务句 `seedTaskFocus` 一次后不自动切；`/goal` 不写 taskFocus；`/goal clear` 清焦点；compact 仍注入。ADR-0024 HITL 段。EXIT：跳过完成向判官，不新增 StopReason。
   - **Surface:** `harness/verify`、`session-api`、`cli`
   - **Acceptance:** 问候轮完成向判官 spawn = 0；有焦点且证据够仍不 spawn 完成向判官；硬失败只打回主模型；源码完成向 `task` 不再 `goal.text ?? query`；你好不成为终身焦点；`/goal` 钉上后 session 不把 goal 写入 taskFocus
   - Status: [ ] pending — [T1 HITL 关闭完成向 LLM，焦点只 seed 一次](https://github.com/winter6205/iknow/issues/572)

2. **自动模式判官信封：task 仅 goal.text，成功也评** — tag: `[implementation]`
   - **Inherits:** spec Does：`task` 仅 `goal.text`；截断对话独立字段；`evidenceContext` 当提示不进 `task`；非硬失败的 `completed` 即使 SUFFICIENT 也 spawn；共用判官、内环 `maxTurns: 2`；装配去掉完整 iknow 灵魂。ADR-0024 自动模式段。
   - **Surface:** `harness/verify`、判官 worker 装配
   - **Acceptance:** 有 goal 时传入判官的 `task === goal.text` 且不含 evidence JSON；SUFFICIENT 仍 spawn ≥ 1；worker 不再以完整 iknow 助手口吻为默认 system
   - Status: [ ] pending — [T2 自动模式判官信封：task 仅 goal.text，成功也评](https://github.com/winter6205/iknow/issues/573)
   - [blocks: T1]

3. **自动循环与三档停法** — tag: `[implementation]`
   - **Inherits:** spec 停法：Impossible 清 goal；连续 3 轮零工具停循环、goal 留着；鉴权/额度/压缩救不了的爆窗/模型不可达清 goal；瞬时错误不清。无默认硬顶；`--max-turns N` 可选。人默认不介入除非 clear/打断。
   - **Surface:** `cli` slash、`session-api` / chat 宿主循环
   - **Acceptance:** 判官未成则自动开下一轮；Impossible 后 goal 空；三轮无工具后循环停且 goal 仍在；钉 `--max-turns 1` 时第二圈不再自动续；`/goal clear` 后下一轮走 HITL
   - Status: [ ] pending — [T3 自动循环与三档停法](https://github.com/winter6205/iknow/issues/574)
   - [blocks: T2]
