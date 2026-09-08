# Spec: 活图阶段 1（会话账本 + 外环剩余子图）

> Map: [#929](https://github.com/winter6205/iknow/issues/929)。本文件不写 CONTEXT / ADR 正文。
> Tracker：不建 GitHub tracer issue（操作员 2026-09-08）。落地 `specs/` + `plans/live-graph-phase1.md`。

## ASSUMPTIONS（本轮 ADR 已收；不重开）

1. 权威是会话 **活图状态**，不是无状态多次 `run_graph` 回执（ADR-0047）。
2. 改结构只在一段 `run_graph` settle 或取消之后（**外环修订**，ADR-0048）。同一次调用波间不改图。
3. 外环只交 **剩余子图**；host 按稳定 id 冻结终态，禁止再跑（ADR-0050）。阶段 1 失败再试 = 新 id，不是图上绕回。
4. 第一次校验通过的交节点建立活图；空开 overlay 不建账本；关 overlay 不销毁；`/reset` 与会话结束销毁；compact 不扔活图（ADR-0051）。
5. 阶段 1 不设外环次数硬顶；effort 缝预留但不触发（ADR-0052）。
6. 图跑着时父代理不能并行干别的；无 `wait:false`；最多主进程静默等待（ADR-0065）。
7. 边指向本次提交没有的 id → 拒（ADR-0066）。阶段 1 看见失败边标记 → 拒，不得忽略后当 DAG 跑（ADR-0067）。
8. 不改 `todo_write` / todo 账本（#929 Notes）。
9. 活图挂在会话运行时对象上（与 messages 同寿、进程内）。不把账本编进 transcript。进程死后从 JSONL resume **不**从对话推断重建活图（空账本）。跨进程持久化活图不在本 spec。
10. 栈仍 TypeScript + vitest；编排仍 `src/harness/graph/`，不引入 LangGraph。

→ 以上视为已确认。

## Glossary（exact copy from docs/CONTEXT.md）

- **graph mode**: 会话级编排 overlay，不是 PermissionMode。Shift+Tab 三态轮 `Default → Auto → Graph → Default`（`/graph` 为非 TTY 对等物）；进 Graph 后**下一次 `run()` 装配**才生效（`run_graph` 由 handler gate 解锁、切换提示追加到 messages 末尾），过程中切换不拦、不中途重装配。ADR-0030；模型面表达方式经 ADR-0041 修订。
- **run_graph**: 常驻注册的 ACI 工具——父代理声明 DAG，host 走 `validateGraph` → waves → `createSubAgentNodeExecutor`；图节点仍是前景 spawn。graph mode 关闭时由 handler 层 EXIT 拒绝调用，工具面不随模式增删（ADR-0041）。跨回合权威不在单次回执里，见 **活图状态**。阶段 2 绕回仍用这一把，不另开工具（ADR-0061）。一段调用在跑时父代理不能并行干别的；最多主进程静默等待（ADR-0065）。
- **活图状态**: 会话持有的那张可修订 DAG 及已完成节点——跨父代理回合、跨多次 `run_graph` 仍是同一张图；已完成在此冻结、不重演。不是 graph mode，也不是单次 `run_graph` 栈帧里的 `GraphExecution`。第一次交节点时建立；关 overlay 不销毁。ADR-0047 / ADR-0051。
- **外环修订**: 改活图剩余结构的刀口——一段 `run_graph` settle 或取消之后，由用户或主代理改 pending（含失败后加重要试格）。阶段 1 的失败再试是加新格，不是图上绕回。ADR-0048。
- **剩余子图**: 外环交给 host 的那一截还要跑的 DAG（新节点与仍 pending 的节点）。已完成节点留在活图上、不出现在这次提交里。Host 按 id 冻结终态，禁止再跑。ADR-0050。
- **NodeOutcome**: 见 `src/harness/graph/types.ts`（done / failed / skipped）。本 spec 冻结 = 该 id 在活图上最后一次结局为 **done** 或 **failed**。skipped 与从未跑过的 id 未冻结。

## Objective

在已有 D-α `run_graph`（一次调用内 Kahn DAG + condense）之上，让同一会话跨多次 `run_graph` 共享一张活图：已终态 id 不重演，外环只交剩余子图。成功 = 下列 Success Criteria 全绿。

## Boundaries

- **Does:**
  - 会话级活图：创建 / 合并剩余子图 / 按 id 冻结 done·failed / 销毁时机。
  - 第二次及以后的 `run_graph` 只 spawn 本次提交里尚未冻结的 id。
  - 调用仍阻塞到 settle 或取消；schema 仍无 `wait`。
  - 阶段 1 拓扑：环 / 自依赖 / 未知 id / 重复 id / 节点上多出来的属性（含任何失败边字段）→ typed 拒绝、零 spawn。
  - 取消：已 done 的 id 留在活图并冻结；未跑完的不冻成成功。
- **Confirms with human:** （none）
- **Out of this spec:**
  - 图内绕回、失败边、同 id 再跑、effort 熔断数字（阶段 2 spec）。
  - TUI `graph_progress` 视觉改版（`tui-run-graph-view.md`）。
  - 给 `run_graph` 加 `wait:false`；父代理跑图时并行其它工具。
  - todo 账本；LangGraph；delta 算子 API；外环次数硬顶。
  - 把活图写入 session JSONL / 跨进程 resume 重建。
  - 改 graph mode overlay 本身（ADR-0030 / 0041）。

## Success Criteria

每条 yes/no。命令以 worktree 根为准；新增测试含进 `npm test` 子集即可，全量 `npm test` 与 `npm run typecheck` 退出 0。

1. **建账本：** 空开 graph mode、一次 `run_graph` 都没有，会话上不存在活图。第一次 `nodes` 通过校验的 `run_graph` 之后活图存在。
2. **关 overlay 不毁：** 活图已建立后关掉 graph mode，再打开，同一会话仍能按冻结 id 拒绝重跑已终态节点。
3. **reset / 会话结束销毁：** `/reset`（或 session hub 对等重置）之后同一会话再 `run_graph` 可重用旧 id 并真正 spawn。会话对象释放后无账本泄漏到新会话。
4. **compact 不扔：** 触发 compact 之后活图仍在；已冻结 id 仍拒再跑。
5. **剩余子图：** 第一段图使 A done；第二段只交 B（deps: [A] 可省略 A 节点）。Host 不重跑 A，B 能跑且能读到 A 的产出（或等价：B 的 task 仍能接到上游结果）。再交 `id: A` 且 A 已 done → typed 拒绝、零新 spawn。
6. **失败也冻：** 阶段 1 某 id **failed** 后，再交同一 id → typed 拒绝。再试必须新 id。
7. **skipped 未冻：** 因上游失败被 skipped 的 id 可以出现在后续剩余子图里并 spawn。
8. **取消：** 调用 abort 时已 done 的 id 冻结；正在跑/未跑的 id 不记成 done。
9. **无外环次数闸：** 连续多次合法剩余子图提交（不少于 3 次）都能跑完，不因「第 N 次外环」失败。
10. **阻塞 + 无 wait：** `run_graph` inputSchema 仍 `additionalProperties: false` 且无 `wait`。带 `wait` 的调用 typed 拒绝。handler 在图未 settle 前不返回成功 condense。
11. **阶段 1 拒失败标记：** 节点对象带失败边字段（例如 `onFailure`）或其它未声明属性 → typed 拒绝、零 spawn；不得当普通 DAG 跑。
12. **未知 id：** `deps` 指向本次 `nodes` 没有的 id → typed 拒绝、零 spawn（与现 `unknown-dep` 一致，且活图合并后仍成立）。
13. **无 LangGraph：** lockfile 不含 `langgraph`。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- `specs/545-d-alpha-graph-mode.md`：overlay、前景节点 spawn、拓扑非法零 spawn、condense、全局 worker cap。
- ADR-0030 / ADR-0041：graph mode；`run_graph` 常驻 + handler gate。
- ADR-0014：节点仍前景 spawn。
- ADR-0046：todo 不是管线。
- ADR-0047–0052、0065–0067。
- 现 `validateGraph` / `runGraph` / `createRunGraphTool`；节点 schema `additionalProperties: false`。
- 测试命令：`npm test`、`npm run typecheck`。

**Changes：**

- 会话持有活图；`run_graph` 按账本冻结合并剩余子图。
- 工具说明需让模型知道：交还要跑的节点，不要为了重放而再交已终态 id（文案由实施定，须覆盖 SC5 行为）。

## architecture-change-reviewer

Affects（实施时）：`src/harness/graph/`、会话持有处（`src/session-api/` 与/或 CLI runtime session）、compact / reset 路径、对应 `tests/`。不改 `src/tui/` 视觉（本 spec）。

```
bounded-context-guardian: yes — 活图权威留在 harness/graph（或其所注入的会话持有接口）；session-api/cli 只持有/销毁，TUI 不当事账本；不把账本塞进 todo 或 transcript。
defensive-contract-validator: yes — 空提交/未知 id、重交冻结 id、skipped 再交、并发同会话两次 run_graph（第二段须等第一段）、abort 中途 五类由活图与 run_graph 测试覆盖。
error-handling-enforcer: yes — 冻结冲突与拓扑非法 typed、零错误 spawn；取消 EXIT 不把半图当成功 condense；无空 catch。
complexity-anti-drift: yes — 账本合并与 Kahn 调度分层；不把 freeze 写进 topo 环检测里搅成一个函数。
minimal-change-verifier: yes — 只加跨调用账本与冻结；不混阶段 2 失败边；plan 一刀一提交。
```

## 待写入

空。
