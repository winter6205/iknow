# Plan: 活图阶段 1

**Goal:** 同一会话多次 `run_graph` 共用活图：已终态 id 不重演，外环只跑剩余子图。
**Approach:** 先把账本挂上会话并测创建/销毁/compact，再做按 id 合并与冻结（含失败冻、skipped 未冻、取消），最后改工具说明并锁「无 wait / 无失败边字段 / 无外环次数闸」。不碰阶段 2 调度。
**Spec link:** `specs/live-graph-phase1.md`
**Tracker:** 本仓库文件。操作员要求不开 GitHub tracer issue。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch. 整轮结束后再 code-review，不在每刀重复。

## 待写入

空。

## ACR

Affects: `src/harness/graph/`、会话持有处（`src/session-api/` 与/或 CLI runtime session）、compact / reset 路径、对应 `tests/`。

```
bounded-context-guardian: yes — 活图权威留在 harness/graph（或其所注入的会话持有接口）；session-api/cli 只持有/销毁，TUI 不当事账本；不把账本塞进 todo 或 transcript。
defensive-contract-validator: yes — 空提交/未知 id、重交冻结 id、skipped 再交、并发同会话两次 run_graph（第二段须等第一段）、abort 中途 五类由活图与 run_graph 测试覆盖。
error-handling-enforcer: yes — 冻结冲突与拓扑非法 typed、零错误 spawn；取消 EXIT 不把半图当成功 condense；无空 catch。
complexity-anti-drift: yes — 账本合并与 Kahn 调度分层；不把 freeze 写进 topo 环检测里搅成一个函数。
minimal-change-verifier: yes — 只加跨调用账本与冻结；不混阶段 2 失败边；一刀一提交。
```

## Tasks (ordered by dependency)

1. **会话持有活图：创建与销毁** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC4 / ADR-0051：第一次校验通过的交节点建账本；空 overlay 不建；关 overlay 不毁；reset 与会话结束销毁；compact 不扔。进程内对象，不写 JSONL。
   - **Surface:** `src/harness/graph`、既有 session 持有（session-api 与/或 CLI runtime）
   - **Acceptance:** 测试能证明「未交节点无账本 / 交过则有 / reset 后旧 id 可再 spawn / compact 后账本仍在」；相关 `npm test` 子集退出 0
   - Status: [ ] pending

2. **剩余子图合并 + 按 id 冻结** — tag: `[implementation]`
   - **Inherits:** spec SC5–SC7 / ADR-0050：只 spawn 未冻 id；done 与 failed 冻；skipped 可再交；第二段可不交已 done 的上游但仍能接到产出。
   - **Surface:** `src/harness/graph`（`run_graph` 入口）
   - **Acceptance:** A done 后只交 B 不重跑 A；再交 A typed 拒零 spawn；failed id 再交拒；skipped id 再交会 spawn
   - Status: [ ] pending
   - [blocks: T1]

3. **取消保留已 done** — tag: `[implementation]`
   - **Inherits:** spec SC8 / ADR-0065：abort 不把半图当成功 condense；已 done 冻结；未跑完不记 done。
   - **Surface:** `src/harness/graph`
   - **Acceptance:** 跑图中 abort：handler typed 取消；随后剩余子图不重跑已 done；未完成 id 可再交
   - Status: [ ] pending
   - [blocks: T2]

4. **合同锁：说明、无 wait、拒多余字段、无外环次数闸** — tag: `[implementation]`
   - **Inherits:** spec SC9–SC12 / ADR-0052 / 0065 / 0067：工具说明写剩余子图；schema 无 wait；多余属性（含失败边字段）拒；连续 ≥3 次合法剩余子图不因次数失败。
   - **Surface:** `src/harness/graph`（`run_graph` schema 与 description）
   - **Acceptance:** 带 `wait` 或 `onFailure` 的节点/调用 typed 拒；三次外环剩余子图都能跑完；`npm run typecheck` 与含本计划测试的 `npm test` 退出 0
   - Status: [ ] pending
   - [blocks: T2]
