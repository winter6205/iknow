# Plan: TUI `run_graph` 执行视图

**Goal:** `run_graph` 运行中 TUI 有 1 行 `graph` chrome，enter 后能按 now/issues/done/waiting 扫读节点状态。
**Approach:** 先打通 scheduler → host 快照（没有 UI 也能测），再 chrome 一行，最后分组视图。三刀可进同一 PR，一刀一 commit。不把 `src/tui/prototypes/` 推进生产。
**Spec link:** `specs/tui-run-graph-view.md`
**Tracker:** 本仓库文件（`specs/tui-run-graph-view.md` + 本 plan）。不另建 GitHub tracer issue；实施按下方 T1–T3 在同一 PR 里一刀一 commit。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch. 整轮（或整 PR）结束后再 code-review，不在每刀重复。

## 待写入

空。

## ACR

Affects: `src/harness/graph/`、`src/harness/stream.ts` 或等价 hub 缝、`src/tui/`、对应 `tests/`。

```
bounded-context-guardian: yes — 编排与 topo 留在 harness/graph；TUI 只消费快照 DTO，不反向 import topo 实现。
defensive-contract-validator: yes — 无快照/空节点、取消中途、节点数滚动溢出、并发 onNode、handler abort EXIT 五类由进度缝 + 视图测试覆盖。
error-handling-enforcer: yes — 沿用 run_graph 取消 EXIT；emit 走 never-throw 观察者；无快照则不画行，不空 catch。
complexity-anti-drift: yes — 快照 / chrome / 分组视图三层，不把分组规则写进 run-graph-tool。
minimal-change-verifier: yes — 只加人眼进度；不混 #727、不把 prototypes 目录当生产。一刀一 commit。
```

## Tasks (ordered by dependency)

1. **图进度快照从 scheduler 推到 host** — tag: `[implementation]`
   - **Inherits:** spec A3 / SC3：`onWave` / `onNode` push；不读 JSONL；`safeEmitStream` 或等价 never-throw；不改拓扑 / cap / 零 spawn。
   - **Surface:** `src/harness/graph`、既有 stream 或 session hub 缝
   - **Acceptance:** `run_graph` 跑起来后，host 能读到含节点 id、deps、status（pending/running/done/failed/skipped）、wave 计数的快照，且随 onNode 更新；取消路径仍 typed；相关 `npm test` 子集退出 0
   - Status: [ ] pending

2. **主会话 `graph` chrome 一行** — tag: `[implementation]`
   - **Inherits:** spec A2 / A4 / A6 / A7 / SC1：用量条下 1 行、英文 `graph`、计数 + now、焦点 `>`、计入 chrome 行账；无快照不出现。
   - **Surface:** `src/tui`
   - **Acceptance:** 有快照时 ContextBar 一带出现该行且 `chromeReserveRows` 含它；无 `run_graph` 不出现；窄屏仍单行不折成产品多行
   - Status: [ ] pending
   - [blocks: T1]

3. **语义分组视图 + 节点 last 输出** — tag: `[implementation]`
   - **Inherits:** spec A5–A9 / SC2：now / issues(+skipped) / done / waiting 分簇 / selected；glyph `*+x-.`；标题 dim；滚动不截 N；enter 节点看 last 文本；esc 返回；禁止原型假聊天进生产。
   - **Surface:** `src/tui`
   - **Acceptance:** 从 graph 行 enter 进入的视图按规则分组；选节点能看到 last/reason；esc 回到 chat；`npm test` 含分组纯函数或视图测退出 0
   - Status: [ ] pending
   - [blocks: T2]
