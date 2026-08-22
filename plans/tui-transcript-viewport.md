# Plan: TUI transcript viewport mount

**Goal:** 撤掉 PR #592 的固定 32 条尾窗，从 PR #591 的全量映射出发，按视口挂载长会话，上翻仍能看到最早消息和方案 B banner。
**Approach:** 先把错误尾窗从树上拿掉（行为回到 #591：能滚到的都在文档里），再加视口+overscan 卸纤维，用 spacer 保 `scrollHeight`。不恢复行账，不钉 banner，不改 session / compact / Web。
**Spec link:** `specs/tui-transcript-viewport.md`
**Tracker:** 本地 `plans/tui-transcript-viewport.md`（用户本轮要求先计划再实施并做完；不另拆 `ready-for-agent` 子 issue，避免与「本轮做完」冲突。GitHub remote 可用，但实施边写在下方 Tasks。）
**待写入:** `viewport mount` → `docs/CONTEXT.md`（视口挂载；Avoid 固定条数尾窗 / 行账 / 用 compact 裁 UI 树）
**ACR:** all-yes（见下）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → one commit on `worktree-tui-viewport-transcript`。整轮结束后主会话做 code-review + verification-before-completion。

**为何 3 个 bullet：** 契约先落盘；再消除 #592；最后才上视口挂载。后两步都改 ChatView，不能并行写同一文件。

## Affected files (planned)

- `specs/tui-transcript-viewport.md` / `specs/README.md` / `docs/CONTEXT.md`
- `plans/tui-transcript-viewport.md`（本文件）；`plans/tui-transcript-mount-window.md`（#592 产物，T2 删除）
- TUI ChatView 与其滚动测（`src/tui/` + `tests/tui/`）
- T2 删除的尾窗模块及其单测
- T3 新增的视口窗口纯函数（模块名留给实现）及其 5 类边界测

## 0. ACR 5-verdict

- bounded-context-guardian: **yes** — 只动 TUI ChatView 挂载；session 全量仍在 `TuiSessionState`；不 import web / session-api / harness 实现细节。
- defensive-contract-validator: **yes** — 视口窗口纯函数覆盖 empty / negative scroll-or-height / overflow 三屏以上 / concurrent 纯函数 / exception 非数组；ChatView 保留空会话 + 100 条滚到顶能见第一条（强于 #592 的 stub 断言）。
- error-handling-enforcer: **yes** — 非数组 `TypeError`；非法 scroll/height clamp 或占位高度，带 EXIT；无空 catch；不把失败渲成空白会话。
- complexity-anti-drift: **yes** — 窗口计算是独立纯函数一层；ChatView 只映射窗口+spacer+既有 tail；禁止把行估算或翻页状态塞回 ChatView。
- minimal-change-verifier: **yes** — 一个产品任务（正确的长会话渲染），拆成 revert 与视口挂载两 commit；不混 banner 短横幅、不改 Web、不改 compact。

**OVERALL: PASS**

## Settled (inherits)

> 引自 `specs/tui-transcript-viewport.md` Invariants / Never do。

- Session 数据全量；只裁 OpenTUI **mount**。
- Banner 方案 B，可随滚动卸下，滚回顶部必须能再看见；不钉死。
- 禁止行账；未测高用与内容无关的常量占位。
- 挂载范围 = 视口 + 至少一屏 overscan；短会话 ≡ #591 全量 map。
- Live tail（thinking/draft/liveTool/ask/spinner/crunched）不进虚拟化集合。
- 删除 `revealOlder`、PgUp 翻页、`↑ N 条更早的消息`。
- 基线：PR #591 `9dc7d60e` 的 `visibleMessages.map`；在当前 master 上 **revert #592 文件**（其后还有 #610 等无关提交，禁止 reset 到 #591）。

## Tasks (ordered by dependency)

1. **记下视口挂载契约** — tag: `[decision]`
   - **Inherits:** spec Invariants 1–7 与 Never do。
   - **Surface:** `specs/` + 本 plan；CONTEXT 词条 `viewport mount`（本 bullet 提交写入）。
   - **Acceptance:** 活跃 spec 索引列出本 spec；plan 含 ACR all-yes；CONTEXT 有 `viewport mount` 且 Avoid 含固定条数尾窗与行账。本 commit 不改运行时代码。
   - Status: [x] done（spec / plan / CONTEXT 本 commit）

2. **消除 #592 尾窗，恢复 #591 全量映射** — tag: `[implementation]`
   - **Inherits:** spec Never do「默认只 mount 最近 N 条」；ChatView 回到 `visibleMessages` 全量 map；无 stub、无 `revealOlder`。
   - **Surface:** TUI ChatView
   - **Acceptance:** 100 条会话 `scrollTop = 0` 的画面含最早用户气泡，**不含**「条更早的消息」；空会话与 sticky / `scrollToBottom` 既有测仍绿；尾窗模块与 `plans/tui-transcript-mount-window.md` 不在树上。
   - Status: [x] done，滚动文档仍全量** — tag: `[implementation]`
   - **Inherits:** spec Invariants 3–6：视口+overscan；spacer 保高度；高度来自布局或常量占位；live tail 不进集合；短会话与 T2 观感相同。
   - **Surface:** TUI ChatView（窗口计算独立一层，不把算法内联进渲染函数）
   - **Acceptance:** 纯函数 5 类边界测绿；100 条滚到顶仍见最早气泡、贴底仍见最后一条；内容不足一屏时无 spacer 缺块、无 stub；挂载区间在 overflow 下明显短于总条数。既有 sticky / 强制滚底不倒退。
   - Status: [x] done
   - [blocks: T2]

## Out of scope

- Web `MessageList`。
- LLM `/compact` 与 session store。
- banner `BANNER_MIN_COLS` 短横幅。
- 恢复 ink 行账 / `MessageBlocksClipped`。
