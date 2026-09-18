# Plan: subagent stop and continue

**Goal:** 父模型能停本会话一名工人；工人进程已死且有工人 transcript 时，能用同一 `task_id` 再给一句并再拉起。同轮多 `spawn_subagent` 即并行（已有 wave，本计划用轨迹钉死，不改 `wait` 默认）。
**Approach:** 先钉同轮轨迹与 `subagent_stop`。再让本切片之后的每次 spawn 边跑边写嵌套工人 transcript。最后 `subagent_continue` = load 该账 + 原 catalog 角色再 `run()`。不往 running 里塞；不从 trace 倒灌旧工人；不扫外部人格目录。TUI 卡与 256k 窗口不在本计划（`plans/strategy-window-and-subagent-card.md`）。
**Spec link:** ADR-0101 / ADR-0102；CONTEXT **同轮多 spawn** / **subagent_stop** / **工人 transcript** / **subagent_continue** / **子代理 task_id**。无独立 `specs/` 文件。
**Predecessor:** ADR-0014 前景默认；从 `plans/strategy-window-and-subagent-card.md` 拆出。
**ACR:** all-yes（block below）
**待写入:** 空（ADR-0101 / ADR-0102 与 CONTEXT 已 flush）
**Issue:** https://github.com/winter6205/iknow/issues/1048
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

> 不重开 ADR-0014 默认前景。中途注入不授权。闸不是 TUI `✓ Done`。

## ACR

bounded-context-guardian: yes — 停/续跑/工人账本留在 harness subagent + session store 嵌套路径 + ACI registry append-only；不新开 technical-layer 目录；TUI 卡不并入。
input-contract-tests: yes — 空/未知 `task_id`；跨会话；对 running 调 continue；无 transcript 的旧 id；终态 stop 幂等；并发顶仍 `SubAgentCapacityError`。
error-handling-enforcer: yes — 拒收走 typed / 结构化 tool_result，不空 catch；abort 失败 EXIT 仍可查态。
complexity-anti-drift: yes — stop、transcript 写、continue 分任务，不合成 god spawn。
minimal-change-verifier: yes — 一任务 = 父模型停 + 工人 transcript + 死进程续跑 + 同轮并行轨迹；不含策略窗口、卡 `✓ Done`、改 wait 默认、listSessions 收录工人。

Affected files (enumerate, not freeze): `src/harness/aci/tools/registry.ts`, `src/harness/subagent/manager.ts`, `src/harness/subagent/worker.ts`, `src/harness/subagent/spawn-subagent-tool.ts`, `src/session-api/store/`（嵌套 load/save 缝）, 新建 stop/continue 工具模块, `tests/subagent/*`, `tests/harness/aci/*`, `tests/session-api/*`。

## Locked sentences

1. 省略 `wait` 仍前景；并行 = 同一 assistant 消息里 N 次 `spawn_subagent`（ADR-0101）。
2. `subagent_stop` 入参本会话 `task_id`，内部 `abortTask`；跨会话拒；已终态/找不到返回结构化说明。
3. 本切片起每次 spawn：工人 loop 边跑边 append **工人 transcript**。落父会话 `subagents/`，键 `(父 conversationId, task_id)`，形状同主会话 JSONL；不得覆盖 `agent-<taskId>.jsonl`；`listSessions` 不收录。
4. `subagent_continue`：进程已死且该 `task_id` 有工人 transcript → load rewind head + 下一句 + 原角色再 `run()`。`running` 拒。`completed` / `failed` / `aborted` 不另分闸。无 transcript 拒。
5. 续跑的 `wait` 与 spawn 相同；占用同一子代理并发顶。装配条件与 spawn / result 相同（有 manager）。
6. 现有 per-agent trace 不动、不当 continue 源。不从 trace 给旧工人造账。

## Tasks (ordered by dependency)

1. **Pin same-turn two-spawn trajectory** — tag: `[implementation]`
   - **Inherits:** 锁句 1；ADR-0101；现有 `isConcurrencySafe`
   - **Surface:** spawn 工具 description / ACI 并发测或 subagent 轨迹夹具
   - **Acceptance:** 同一 assistant 消息两条 `spawn_subagent` 起两个 `task_id`、两进程；跨回合第二条在第一条 `wait:true` 终态之后才出现。不改默认 `wait`
   - Status: [x] done
   - [parallel]

2. **Parent `subagent_stop`** — tag: `[implementation]`
   - **Inherits:** 锁句 2；ADR-0101；与 Ctrl+X 同一 `abortTask`
   - **Surface:** ACI registry append-only + stop handler
   - **Acceptance:** running → 进程结束、可查 failed/aborted；终态再 stop 结构化说明非抛错；跨会话拒。`npm test` 覆盖空 id / 未知 id / 本会话 running / 终态幂等
   - Status: [x] done
   - [parallel]

3. **Worker transcript on every new spawn** — tag: `[implementation]`
   - **Inherits:** 锁句 3、6；ADR-0102；ADR-0027 JSONL；不得当第二份 trace
   - **Surface:** worker loop 写盘 + session store 嵌套键；envelope 带路径
   - **Acceptance:** 新 spawn 跑过之后父会话 `subagents/` 下有独立于 `agent-<taskId>.jsonl` 的 transcript，load 投影含该次对话事件；`listSessions` 条目数不因工人增加；旧布局工人无此文件。`npm test` 覆盖空父 id / 与 trace 文件分家
   - Status: [x] done
   - [parallel]

4. **`subagent_continue` when process is dead** — tag: `[implementation]`
   - **Inherits:** 锁句 4–5；ADR-0102；T3 文件已在
   - **Surface:** continue 工具 + manager 再拉起
   - **Acceptance:** failed/aborted/completed + 下一句 → 新进程、原 `task_id`、prior 含续跑前 transcript；running 拒；无文件拒；跨会话/未知 id 拒。前景 continue 当跳返回信封。`npm test` 覆盖上述入参类
   - Status: [x] done
   - [blocks: T2, T3]

## Code review phase

整轮落地后 `code-review`；`GATE: BLOCKED` → `review-report-repair`。
