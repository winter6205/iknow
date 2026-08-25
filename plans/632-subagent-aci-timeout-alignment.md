# Plan: 632 — spawn_subagent ACI timeout 不再提前砍子代理

**Goal:** 前景 `spawn_subagent`（wait:true）的寿命由 manager per-task 钟（`PER_TASK_TIMEOUT_MS` 2h）决定，ACI tool-tier 不再用 30min `long` / 文案里的 5min 提前 abort。对齐 Claude Code：Agent 等待不套短工具超时。

**Spec link:** none（对照 #358 Assumptions 1 + ADR-0014 wait:true；本轮修时钟错位，不改 wait 默认）。

**Worktree:** `.claude/worktrees/fix-subagent-timeout`

---

## Problem

三层时钟不一致，子代理「干不了活」：

1. 工具 description / schema 写 **5 min default** → 模型常显式传 `timeoutMs: 300000`，manager SIGTERM 在 5 分钟。
2. `aci.timeoutTier: "long"` = **30 min**，小于 `PER_TASK_TIMEOUT_MS` **2 h**。ACI executor 对 wait:true 下 AbortSignal，waitFor 走 cancelled，不是 timeout envelope。注释写「tier ≥ PER_TASK」但未守门。
3. `SubAgentWaitTimeoutError` 复用于 unknown task / failed-without-envelope / shutdown / 墙钟；handler 若一律合成 timeout envelope 会误报。

参照 `AgentTool` 是 fire-and-forget spawn，工具层无阻塞超时。iknow 保持 ADR-0014 `wait:true`，只把 **ACI 层超时拿掉**（`unbounded=0`，走既有 `tierTimeoutMs > 0` 门），寿命仍归 manager。

---

## Architecture Change Reviewer verdict

```
bounded-context-guardian: yes — TimeoutTier SSOT 仍在 aci/types.ts；spawn 只改本工具 meta/handler；manager waitFor 合同不变（不加 grace，避免打破 taskTimeoutMs=50 用例）。
defensive-contract-validator: yes — empty: wait 缺省仍返 envelope；negative: WaitTimeout + queryBuffer not_found → ToolExecutionError；overflow: unbounded=0 不套 30min；concurrent: signal.aborted 优先于 WaitTimeoutError（仍 cancelled）；exception: WaitTimeout + running → failed timeout envelope；WaitTimeout + failed buffer → 原 envelope。
error-handling-enforcer: yes — WaitTimeoutError 不 catch-all 合成 timeout；queryBuffer 四态分流 + EXIT 注释；abort 臂不变。
complexity-anti-drift: yes — 新增 unbounded 档 + handler 一个分流函数；不改 waitFor 公式。
minimal-change-verifier: yes — 1 逻辑任务（对齐 spawn 时钟），1 commit。
```

---

## Tracer bullets

### T1. `[implementation]` ACI unbounded + description 2h + WaitTimeout 分流

- **Affects:** `src/harness/aci/types.ts`；`src/harness/subagent/spawn-subagent-tool.ts`；`tests/subagent/spawn-subagent.test.ts`；`tests/harness/aci/interrupt-routing.test.ts`；`tests/subagent/foreground-contract.test.ts`；`CHANGELOG.md`
- **Acceptance:**
  1. `TIMEOUT_TIER_MS.unbounded === 0`；`spawn_subagent.aci.timeoutTier === "unbounded"`。
  2. description / `timeoutMs` schema **不**匹配 `5 min`，**匹配** 2h / `PER_TASK` 语义。
  3. wait:true + `SubAgentWaitTimeoutError` + `queryBuffer running` → `{status:failed, reason:timeout}` 作 ok 数据。
  4. 同上 + `not_found` → `ToolExecutionError`（不谎报 timeout）。
  5. 同上 + `signal.aborted` → `ToolExecutionError` cancelled（abort 优先）。
  6. 同上 + buffer 已是 failed envelope → 原样返回。
  7. `npx vitest run tests/subagent/spawn-subagent.test.ts tests/subagent/foreground-contract.test.ts tests/harness/aci/interrupt-routing.test.ts` exit 0。
