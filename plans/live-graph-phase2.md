# Plan: 活图阶段 2

**Goal:** 同一段 `run_graph` 内按标明的 `onFailure` 走一格（回走未冻 id 或开新格），并用每 id 进入 8 次熔断空转。
**Approach:** 先扩展 schema 与校验（deps 环仍拒、失败边合法），再调度按 NodeOutcome 走边并同 id 再进，最后打上 8 次熔断。不改 TUI、不加第二把工具。
**Spec link:** `specs/live-graph-phase2.md`
**Tracker:** 本仓库文件。操作员要求不开 GitHub tracer issue。阶段 1 plan 全绿后再实施本文件。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch. 整轮结束后再 code-review，不在每刀重复。

## 待写入

空。

## ACR

Affects: `src/harness/graph/`（schema、校验、调度、effort）、对应 `tests/`。

```
bounded-context-guardian: yes — 仍在 harness/graph；不新工具名；session 只继续持有活图。
defensive-contract-validator: yes — 空/未知 onFailure、冻 id、deps 环、并发进入超 8、executor 抛错 五类由校验+调度+熔断测试覆盖。
error-handling-enforcer: yes — 非法图与熔断 typed；熔断不丢已 done；无空 catch。
complexity-anti-drift: yes — 前进校验 / 失败边启用 / effort 计数分开，不把熔断塞进 validateGraph。
minimal-change-verifier: yes — 只加失败边与熔断；一刀一提交；阶段 1 冻结语义不重写。
```

## Tasks (ordered by dependency)

1. **`onFailure` schema + 校验** — tag: `[implementation]`
   - **Inherits:** spec SC4–SC5 / Changes：可选 `onFailure` string；`additionalProperties: false`；未知 id、活图已冻 id、两条失败边、仅 `deps` 成环 → 拒零 spawn。`deps` 自依赖仍拒；`onFailure` 指向自己合法。
   - **Surface:** `src/harness/graph`
   - **Acceptance:** 合法带 `onFailure` 的提交通过校验；上列非法形 typed 拒且不 spawn；不带该字段的 DAG 仍与阶段 1 相同拒绝规则
   - Status: [ ] pending

2. **按 NodeOutcome 走失败边 + 同 id 再进入** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC3、SC6、SC8 / ADR-0053–0056、0062–0063：failed 才走唯一 `onFailure`；done 不走；skipped 不走；终点 done 则 typed 拒不 spawn；同一未冻 id 可第二次进入；整段仍一次 handler 阻塞返回。
   - **Surface:** `src/harness/graph`（调度，不锁算法名）
   - **Acceptance:** 自回边与指向新格的失败边行为符合 SC1–SC2；skipped 不触发；done 终点不重跑；测试能看到同一 id 两次进入
   - Status: [ ] pending
   - [blocks: T1]

3. **effort 阈 8 熔断** — tag: `[implementation]`
   - **Inherits:** spec SC7 / ADR-0064：一次调用每 id 进入含首次；第 9 次 typed 熔断；≤8 不熔；已 done 保留；外环新 id 仍可跑。不进 settings。
   - **Surface:** `src/harness/graph`
   - **Acceptance:** 同 id 第 9 次进入熔断且 done 仍冻；8 次合法再进不熔；`npm run typecheck` 与含本计划测试的 `npm test` 退出 0
   - Status: [ ] pending
   - [blocks: T2]
