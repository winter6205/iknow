# 0101. 同轮多 spawn 即并行；父模型停工人走 `subagent_stop`

Date: 2026-09-18
Status: accepted

Amends ADR-0014（只补控制面，不改 `wait` 默认）。不改 ADR-0040 的双重 `conversationId`。

## Context

ADR-0014 已定：省略 `wait` = 前景；后景只显式 `wait:false`。工具注释与 description 也写了「一回合多条 `spawn_subagent` 可并行」。缺的是把这条写成合同，并补上父模型停工人的对称面。

现势：`spawn_subagent` 标 `isConcurrencySafe: true`，同一 assistant 消息里多条 spawn 会进同一 wave 并发起工人。跨回合的 `wait:true` 会把父绑在上一跳终态上，看起来像「只能一个一个派」，这是前景契约，不是渲染或 catalog 故障。操作员已有 Esc（本会话全部前景）和 Ctrl+X（焦点行 `abortTask`）。父模型没有对等工具：registry 有 `bash_stop`，没有 `subagent_stop`。交差信封上的 `task_id` 已能用于 `subagent_result`、mailbox、tmp 与人侧 abort。终态后续跑见 ADR-0102；本篇不裁定续跑寿命。

## Decision

1. **并行产品 = 同一 assistant 消息里 N 次 `spawn_subagent`。** 各调用自有 `task_id`；`wait:true` 时各 handler 阻塞到自己的工人终态，wave 内并发启动。跨回合再 spawn 被上一跳前景挡住，是默认契约，不另开「自动改 `wait:false`」来假装并行。
2. **后景臂仍是显式选项，不是并行的定义。** `wait:false` 解决「父还要在本回合干别的 / mailbox 终态叫醒」，不替代同轮多 spawn。
3. **父模型停工人：新工具 `subagent_stop`。** 入参是本会话可见的 `task_id`，内部走既有 `abortTask`（与 Ctrl+X 同一杀进程路径）。范围对齐 `bash_stop`：只停本会话派出的工人，跨会话拒。幂等：已终态 / 找不到 → 结构化说明，不抛成「任务失败幻觉」。装配条件与 `spawn_subagent` / `subagent_result` 相同（有 `subagentManager`）。
4. **`task_id` 在本篇的含义。** 这一次派出的 manager 句柄：查、mailbox、父可见信封、tmp、人停、`subagent_stop`。worker 自己的 `conversationId` 仍按 ADR-0040 管子侧 trace / 回合，不拿来当父工具入参。
5. **续跑不在本篇。** 终态后再塞一句见 ADR-0102。中途往 running loop 塞话仍不做。

## Why not

**Why not 把默认改成 `wait:false` 才叫并行：** ADR-0014 2026-09-18 已否；前景当回合闭环仍要。  
**Why not 只靠加长 description 让模型跨回合先 `wait:false`：** 说明书不是闸；真并行闸是同轮 wave。  
**Why not 让父模型调 `abortTask` 或复用 `bash_stop`：** 那是 manager / bash 进程组句柄，不是子代理生命周期。  
**Why not 本篇顺便定终态续跑：** 续跑改的是工人会话寿命，不是停与同轮启动；见 ADR-0102。

## Consequences

- (+) 双卡「一个已完、一个还在跑」成为同轮两 spawn 的合法画面；单卡串行多半是跨回合前景，不是 TUI 丢了一张。
- (+) 父模型与操作员停工人同一 `task_id` / `abortTask` 路径。
- (−) 工具面 +1；需 append-only 进 registry，并写轨迹：同轮双 spawn 起两个 worker；`subagent_stop` 停 running、对终态幂等、跨会话拒。
- (−) 在 ADR-0102 落地前，停 = 进程结束；`task_id` 仍可查档案，不能把同一工人再叫起来。

## Evidence

- `src/harness/subagent/spawn-subagent-tool.ts`：`isConcurrencySafe: true`；文件头注释写明同一 turn 多 spawn。
- `src/harness/aci/aci-executor.ts`：连续 `isConcurrencySafe` 同 wave `Promise.all`。
- `src/harness/subagent/manager.ts`：`abortTask`；TUI Ctrl+X / Esc 扇出已接。
- `src/harness/aci/tools/registry.ts`：`bash_stop` 在场，`subagent_stop` 缺席。
- ADR-0014 Decision 3 原文已含 "issue multiple calls in one turn to parallelize"。
