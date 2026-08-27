# Spec: D-α V1 graph mode（编排 overlay + `run_graph`）

> Spec issue: [#715](https://github.com/winter6205/iknow/issues/715). Wayfinder: map [#540](https://github.com/winter6205/iknow/issues/540) · 设计 [#545](https://github.com/winter6205/iknow/issues/545) CLOSED（决议 + amendment）。
> 本文件 **不写** CONTEXT / ADR 正文；术语与 ADR-0030 由本 PR 的 `domain-modeling` 落盘（见文末 **待写入** = 已随本 PR flush）。
> 草稿 PR 链 #698–#707 **对照可摘，不合整链当接入**。LangGraph / PR #382 **不用**。

## ASSUMPTIONS（#545 已收；不重开）

1. graph = **可选 overlay**，默认任务走 `spawn_subagent`，不进图。
2. **graph mode** 不是 `PermissionMode`。Shift+Tab 三态轮 `Default → Auto → Graph → Default`；进 Graph 冻结当时 permission。
3. `/graph on|off` 是非 TTY 对等物；settings 一项作新会话默认，**默认关**。
4. 编排段 + `run_graph` 只在**下一次 `run()` 装配快照**注入/露出。过程中切换不拦、不中途重装配、不防抖。
5. 节点执行 = 已有 `createSubAgentNodeExecutor`：`manager.spawn` + `waitFor`（前景）。不经父代理再调 `spawn_subagent` 工具。
6. 模块保持 `src/harness/graph/`，与 `subagent/` 同级。自写；**不**引入 LangGraph。
7. V1 只前景等待；`wait: false` 节点字段保留不消费。共用 ADR-0014 全局 cap 4；**不**另起 per-graph budget（草稿 #706 OUT）。
8. 动态分解 OUT。进图任务数 N **不锁**（不是「≥2 就必须走图」）；e2e 只要能证明「这是图不是单次 spawn」。
9. 观测地板同期（`fileRefs` 真写、`stop_reason` additive、`SUBAGENT_STEP`）。草稿 #698 可摘；其文件 `docs/adr/0030-subagent-manager-per-session-ownership.md` **必须改号**（本仓 ADR-0030 已分给 graph mode）。
10. 零新 runtime 依赖。栈仍 TypeScript + vitest。
11. 草稿 `#701` 的 `GraphModeContext` + `/graph` 三入口 **可摘**；`IKNOW_GRAPH_MODE` env **不是**人机主路径（测试/CI 覆盖可留，产品 SSOT = Shift+Tab + `/graph` + settings）。
12. 草稿 `#702/#707` 的 e2e / TUI+serve 入口 **可摘**，须改成「先进 graph mode 再 `run_graph`」，不是 host 直接 `run-declared` 绕过模型工具。

→ 以上视为已确认。实施不得把 #545 当未决重开。

## Glossary（exact copy from docs/CONTEXT.md）

- **deps.system injection seam**: Each-turn 系统文本装配的唯一权威缝——loop-engine 调 `deps.system?.()`，结果透传 `adapter.step request.system`；`undefined` 时不发送 `system` 字段，KV cache 前缀字节级稳定。装配主体是 `identity/assemble.ts` 的 `IKNOW_ASSEMBLY_ORDER` 流水线。
- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。
- **前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`，显式选项）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程，与前景/后景正交。
- **graph mode**: 会话级编排 overlay，不是 PermissionMode。Shift+Tab 三态轮 `Default → Auto → Graph → Default`（`/graph` 为非 TTY 对等物）；进 Graph 后**下一次 `run()` 装配**才注入编排段并露出 `run_graph`，过程中切换不拦、不中途重装配。ADR-0030。
- **run_graph**: 仅 graph mode 打开时装配的 ACI 工具——父代理声明 DAG，host 走 `validateGraph` → waves → `createSubAgentNodeExecutor`；图节点仍是前景 spawn。默认模式不装。

## Objective

用户在 TTY 用 Shift+Tab（或 `/graph`）进入 graph mode 后，**下一次**主代理 `run()` 能看见编排段和 `run_graph`，从而用本仓 `src/harness/graph/` 编排多个有依赖的子代理（前景等待），浓缩结果回到当回合。默认模式行为不变。成功 = 下列 Success Criteria 全绿。

## Boundaries

- **Does:**
  - graph mode overlay：Shift+Tab 三态轮 + `/graph` 三入口 + settings 持久默认；与 `PermissionMode` 正交。
  - `run_graph` 条件装配（`ACI_TOOLSET_NAMES` append-only + Gate 3）；仅 graph mode 打开且该次 `run()` 快照为开时入注册表。
  - 编排提示为 **additive assembly 段**（不改 `IKNOW_ASSEMBLY_ORDER` 5 段 LOCKED 顺序），同 catalog persona 加性先例。
  - 接线已有 `validateGraph` / `topoWaves` / `runGraph` / `skillCheckGate` / `createSubAgentNodeExecutor`。
  - 观测地板：`envelope.fileRefs` 填充、`stop_reason` additive（不进 status 枚举）、`SUBAGENT_STEP` record_type；trace 三事件 spawn / state_change / stop 在图节点路径上可见。
  - 失败：拓扑非法 typed 拒绝且零 spawn；节点 fail-fast 沿 deps；独立分支继续；容量走 `SubAgentCapacityError`。
- **Confirms with human:** 进图任务数 N、prompt 里何时建议 `run_graph`（实施时真任务测，本 spec 不写死）。
- **Out of this spec:**
  - LangGraph / PR #382；任何新编排依赖。
  - per-graph inflight budget（草稿 #706；Phase 2）。
  - 动态分解、mailbox、事件驱动唤醒（#546）、coordinator 模式（#547）。
  - 把 Graph 写入 `PERMISSION_MODES`；进图改 ask/auto。
  - 切模式当下 round 热替换工具面。
  - 合入 #698–#708 整链当「已接入」；`parentTurnId` 填实（#703，Phase 2）。
  - 把 `src/harness/graph/` 路径写进模型 prompt。

## Success Criteria

每条 yes/no。命令以 worktree 根为准。

1. **模式正交**：`PERMISSION_MODES` 仍仅 `default | plan | full_auto`。Shift+Tab 从 Default 两次到 Graph，再一次回 Default。Graph 时 mutating 仍按进入前的 permission 问/放行。`npx vitest run` 覆盖 `nextShiftTabMode` / 等价 graph overlay 循环的测试退出码 0。
2. **装配快照**：graph 关闭时该次 `run()` 的可见工具名不含 `run_graph`。打开 overlay 后**下一次** `run()` 含 `run_graph` 且 system 文本含编排段（不要求含模块路径 `src/harness/graph`）。同一次 in-flight `run()` 内翻键不改变该次已装配工具面。
3. **斜杠对等**：chat / TUI / serve 的 `/graph on` 与 Shift+Tab 进 Graph 是同一 overlay（同一 holder）。`/graph off` 后下一次 `run()` 不再装 `run_graph`。
4. **拓扑失败零 spawn**：环 / 自依赖 / 未知依赖 → typed 校验失败；该次不调用 `SubAgentManager.spawn`。测试退出码 0。
5. **图不是单 spawn**：存在一条 e2e（stub 或 live）跑一张 **带至少一条 dep 边、至少两个节点** 的图，前景等待，父代理收到浓缩结果；trace 含 `subagent_spawn` / `subagent_state_change` / `subagent_stop`。节点数不是产品策略。缺 LLM key 时 live 标 Not run，stub 路径仍必须绿。
6. **无 LangGraph**：`package.json` / lockfile 不含 `langgraph`。`npm run typecheck` 退出 0；`npm test` 退出 0（本 spec 新增测试含在内）。

## Open Questions

(none) — N 与 prompt 时机明确留给实施实测，不是 PLAN 前阻塞项。

## Inherits / Changes

**Inherits：**

- ADR-0014 前景默认、全局 `MAX_CONCURRENT_WORKERS = 4`、引导层必做；否决 env gate 才注入 coordinator。
- ADR-0004 `ACI_TOOLSET_NAMES` append-only；新工具末尾追加 + 条件装配。
- ADR-0003 `recordXxx` never-throw；envelope status/reason 枚举不扩（`stop_reason` 只 additive 字段）。
- `IKNOW_ASSEMBLY_ORDER` LOCKED 5 段；加性段不重排（assemble.ts 已有 additive 先例）。
- `src/harness/graph/` 原型：`topo` / `scheduler` / `partition-by-coupling` / `skill-check-gate` / `node-executor`（#544 折入）。
- 草稿对照（不整链 merge）：#698 观测地板、#700 执行层产品化、#701 `GraphModeContext`+`/graph`+settings、#702 e2e 夹具、#705 scheduler ready-set、#707 TUI/serve 入口。
- 测试命令：`npm test`、`npm run typecheck`。T8 夹具已在 master（#699）。

**Changes：**

- 新 overlay graph mode + `run_graph`（ADR-0030）。
- Shift+Tab 占用 agent-mode 轮（override #540 旧「不占用」）。
- 实施若摘 #698：将其 ADR 文件改号为 **0031+**，不得覆盖 ADR-0030 graph mode。
- `settings.graph` 段（结构由实施定；缺省 `enabled: false`）。

## architecture-change-reviewer

Affects (实施时，非本 docs PR)：`src/harness/graph/`、`src/harness/permission/modes.ts`、`src/harness/aci/tools/registry.ts`、`src/harness/identity/assemble.ts`、`src/harness/subagent/`（观测）、`src/cli/`、`src/tui/`、`src/session-api/`、`src/config/settings.ts`、对应 `tests/`。

```
bounded-context-guardian: yes — 编排留在 harness/graph；overlay 与 PermissionMode 分轴；cli/tui/session-api 只消费 GraphModeContext，不反向 import graph 内部 topo。
defensive-contract-validator: yes — 空 DAG / 环依赖 / cap 溢出 / 并发 in-flight 翻模式 / validate 抛错 五类由 run_graph 与 mode holder 测试覆盖。
error-handling-enforcer: yes — 拓扑失败 typed、零 spawn；容量 SubAgentCapacityError；无空 catch；fallback 写 EXIT（关图时不装工具）。
complexity-anti-drift: yes — mode overlay、装配快照、executor 三层分开，不把 Shift+Tab 塞进 PERMISSION_MODES 枚举。
minimal-change-verifier: yes — 实施按 plan tracer bullet 一刀一提交；本 PR 只落 spec/plan/ADR/CONTEXT。
```

## 待写入

空（`graph mode` / `run_graph` + ADR-0030 与本 spec 同 PR flush）。
