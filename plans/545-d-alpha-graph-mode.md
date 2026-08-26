# Plan: D-α V1 graph mode

**Goal:** 用户切到 graph mode 后，下一次 `run()` 能用本仓 `run_graph` 前景编排带依赖的子代理，默认模式不变。
**Approach:** 先摘观测地板（#698 对照），再落 overlay 入口（#701 + Shift+Tab），然后条件装配 `run_graph` 并接到已有 graph executor（#700/#705，不摘 #706）。e2e 证明「图 ≠ 单 spawn」。不整链合入 #698–#708，不引入 LangGraph。
**Spec link:** `specs/545-d-alpha-graph-mode.md`
**Tracker:** GitHub — spec [#715](https://github.com/winter6205/iknow/issues/715)；bullets [#716](https://github.com/winter6205/iknow/issues/716) T1 · [#717](https://github.com/winter6205/iknow/issues/717) T2 · [#718](https://github.com/winter6205/iknow/issues/718) T3 · [#719](https://github.com/winter6205/iknow/issues/719) T4 · [#720](https://github.com/winter6205/iknow/issues/720) T5（`ready-for-agent`；native blocked-by 已接）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch. 整轮结束后再 code-review，不在每刀重复。

## 待写入

空。

## ACR

Affects: `src/harness/graph/`、`src/harness/permission/modes.ts`、`src/harness/aci/tools/registry.ts`、`src/harness/identity/assemble.ts`、`src/harness/subagent/`、`src/cli/`、`src/tui/`、`src/session-api/`、`src/config/settings.ts`、对应 `tests/`。

```
bounded-context-guardian: yes — 编排留在 harness/graph；overlay 与 PermissionMode 分轴；cli/tui/session-api 只消费 GraphModeContext，不反向 import graph 内部 topo。
defensive-contract-validator: yes — 空 DAG / 环依赖 / cap 溢出 / 并发 in-flight 翻模式 / validate 抛错 五类由 run_graph 与 mode holder 测试覆盖。
error-handling-enforcer: yes — 拓扑失败 typed、零 spawn；容量 SubAgentCapacityError；无空 catch；fallback 写 EXIT（关图时不装工具）。
complexity-anti-drift: yes — mode overlay、装配快照、executor 三层分开，不把 Shift+Tab 塞进 PERMISSION_MODES 枚举。
minimal-change-verifier: yes — 每条 tracer bullet 一逻辑任务一提交；摘草稿时只带该刀范围，不整链 rebase。
```

## Tasks (ordered by dependency)

1. **Observability V1 floor** — tag: `[implementation]` · [#716](https://github.com/winter6205/iknow/issues/716)
   - **Inherits:** spec SC5 trace 三事件 + `fileRefs` 真写 + `stop_reason` additive 不进 status 枚举 + `SUBAGENT_STEP`；ADR-0003 never-throw。对照 [PR #698](https://github.com/winter6205/iknow/pull/698)。若落 per-session manager ADR，编号必须是 **0031+**，不得覆盖 ADR-0030。
   - **Surface:** `src/harness/subagent`、`src/harness/trace`、traceserver 读侧
   - **Acceptance:** 一次前景 spawn 的 JSONL 含 spawn/state_change/stop；envelope 有 fileRefs（有文件时）与 additive stop_reason；`npm test` 相关子集退出 0
   - Status: [ ] pending
   - [parallel]

2. **Enter graph mode overlay** — tag: `[implementation]` · [#717](https://github.com/winter6205/iknow/issues/717)
   - **Inherits:** ADR-0030：三态轮 Default→Auto→Graph→Default；`/graph` 对等；settings 默认关；进 Graph 冻结 permission；不写入 `PERMISSION_MODES`。对照 [PR #701](https://github.com/winter6205/iknow/pull/701) 的 `GraphModeContext`。env 不是人机 SSOT。
   - **Surface:** `src/harness/permission`、`src/harness/graph`（mode holder）、cli / tui / session-api
   - **Acceptance:** Shift+Tab 与 `/graph on|off` 改同一 holder；Graph 时 permission 仍为进入前的 default 或 auto；plan 仍不进轮
   - Status: [ ] pending
   - [parallel]

3. **`run_graph` + 装配快照** — tag: `[implementation]` · [#718](https://github.com/winter6205/iknow/issues/718)
   - **Inherits:** spec SC2：仅 graph 开着的那次 `run()` 装配才露出工具与编排段；加性段不改 `IKNOW_ASSEMBLY_ORDER`；`ACI_TOOLSET_NAMES` append-only。过程中切换不热替换本 round。
   - **Surface:** `src/harness/aci/tools`、`src/harness/identity`、`src/harness/build-engine`
   - **Acceptance:** 关图 `run()` 工具名无 `run_graph`；开图后下一次 `run()` 有 `run_graph` 且 system 含编排段、不含模块路径字面量；同 round 翻键不改已装配工具面
   - Status: [ ] pending
   - [blocks: T2]

4. **Executor 接到 `run_graph`** — tag: `[implementation]` · [#719](https://github.com/winter6205/iknow/issues/719)
   - **Inherits:** spec：`validateGraph` → waves → `createSubAgentNodeExecutor`；节点前景 spawn+waitFor；环/未知依赖零 spawn；共用全局 cap 4。对照 [PR #700](https://github.com/winter6205/iknow/pull/700) / [#705](https://github.com/winter6205/iknow/pull/705)。**不摘** [#706](https://github.com/winter6205/iknow/pull/706) per-graph budget。
   - **Surface:** `src/harness/graph`、`run_graph` handler
   - **Acceptance:** 合法带 dep 边的图跑完返回浓缩结果；环图 typed 失败且 spawn 次数为 0；打满 4 走既有容量错误
   - Status: [ ] pending
   - [blocks: T3]

5. **三入口 e2e** — tag: `[implementation]` · [#720](https://github.com/winter6205/iknow/issues/720)
   - **Inherits:** spec SC5–SC6：至少两节点 + 至少一条 dep 边；N 不是产品策略；缺 key 则 live Not run。对照 [#702](https://github.com/winter6205/iknow/pull/702) / [#707](https://github.com/winter6205/iknow/pull/707) 夹具，须走 `run_graph` 而不是 host 绕过工具。
   - **Surface:** tests + cli/tui/serve 入口
   - **Acceptance:** stub（或 live）路径退出 0；trace 三事件可见；`npm run typecheck` 与 `npm test` 退出 0；lockfile 无 langgraph
   - Status: [ ] pending
   - [blocks: T1, T4]
