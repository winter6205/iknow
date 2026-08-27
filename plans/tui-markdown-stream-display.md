# Plan: TUI markdown 围栏显示窗 + 流式块冻结

**Goal:** 聊天里的围栏代码块默认只画 32 行并提示溢出；正在生成的回复里，已经写完的顶层块不再每个新字整篇重画。
**Approach:** 先把契约落盘。再给围栏加显示窗（历史和草稿立刻受益）。最后给会变长的草稿加上「只更新最后一块」，避免前缀跟着后缀一起重建。两刀都改 markdown 展示，串行，避免同文件互踩。
**Spec link:** `specs/tui-markdown-stream-display.md`
**Tracker:** 本地 `plans/tui-markdown-stream-display.md`（本轮只要仓库文档；不另开 GitHub issue。）
**待写入:** `fence display cap`、`streaming block freeze` → `docs/CONTEXT.md`
**ACR:** all-yes（见下）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → one commit。整轮结束后主会话做 code-review + verification-before-completion。

**为何 3 个 bullet：** 契约必须先于代码；显示窗与流式冻结是两个可独立验收的行为，但都碰 markdown 渲染，不能并行改同一处。

## Affected files (planned)

- `specs/tui-markdown-stream-display.md` / `specs/README.md` / `docs/CONTEXT.md`
- `plans/tui-markdown-stream-display.md`（本文件）
- TUI markdown 展示及现有 markdown / ChatView 测（`src/tui/` + `tests/tui/`）

## 0. ACR 5-verdict

- bounded-context-guardian: **yes** — 只动 TUI markdown 展示；session / compact / Web / 工具预览窗数字不动。
- defensive-contract-validator: **yes** — 显示窗与冻结两套纯函数各覆盖 spec EXIT 的 5 类边界；ChatView/Markdown 集成锁超长围栏与「前缀不随后缀重解析」。
- error-handling-enforcer: **yes** — 非法窗宽退回 32；非字符串 text 抛 typed `TypeError`；无空 catch；失败不渲成空白会话。
- complexity-anti-drift: **yes** — 窗切与冻结各一层纯函数；`Markdown` 只消费结果；禁止把行账或消息尾窗塞进同一函数。
- minimal-change-verifier: **yes** — 一个产品任务（降低大围栏与流式草稿的挂载成本），拆成契约 / 显示窗 / 冻结三 commit；不混视口算法、不改工具 6 行窗。

**OVERALL: PASS**

## Settled (inherits)

> 引自 `specs/tui-markdown-stream-display.md` Invariants / Never do。

- Session 全文不变；只裁树上的围栏行与流式前缀子树。
- 不是「最近 N 条消息」。
- 围栏可见窗 = 32 行；溢出文案形态与工具预览的 `还有 N 行` 一致；工具预览仍 6 行。
- 本轮无展开全文。
- 流式：除最后一个顶层块外钉住；边界只前进；最后一块仍受 32 行窗约束。
- 不恢复行账 / 整条消息物理行切片。

## Tasks (ordered by dependency)

1. **记下围栏显示窗与流式冻结契约** — tag: `[decision]`
   - **Inherits:** spec Invariants 1–8 与 Never do。
   - **Surface:** `specs/` + 本 plan；CONTEXT 词条 `fence display cap`、`streaming block freeze`。
   - **Acceptance:** 活跃 spec 索引列出本 spec；plan 含 ACR all-yes；CONTEXT 有上述两词且 Avoid 含消息条数尾窗、与工具 6 行窗混用、行账。本 commit 不改运行时代码（词条与索引除外）。
   - Status: [x] done（spec / plan / 索引 / CONTEXT 本轮文档）

2. **围栏只挂显示窗内的行** — tag: `[implementation]`
   - **Inherits:** spec Invariants 3–5、7：32 行；`还有 N 行`；历史 / 草稿 / 展开 thinking 凡走 markdown 围栏均适用；无展开。
   - **Surface:** TUI markdown 展示
   - **Acceptance:** 纯函数 5 类边界测绿。画面：33 行围栏可见前 32 行与溢出提示，不可见第 33 行源码。不足 32 行无溢出提示。既有 write/edit 6 行预览测不倒退。`npx vitest run` 覆盖所涉 tui 测全绿。
   - Status: [x] done
   - [blocks: T1]

3. **流式草稿只更新最后一个顶层块** — tag: `[implementation]`
   - **Inherits:** spec Invariants 6–7：前缀钉住、边界单调、最后一块仍受显示窗约束。
   - **Surface:** TUI markdown 展示（live tail 上会变长的 text）
   - **Acceptance:** 纯函数：单块无前缀；多块时后缀变长前缀 raw 不变且边界不回退。集成：草稿先闭合一块再增长下一块，后续增量不再 lexer 第一块正文。超长未闭合围栏仍不超过 32 行代码节点。T2 测仍绿。
   - Status: [ ] pending
   - [blocks: T2]

## Out of scope

- 视口挂载 / 全量挂载阈值 / 滚动事件量化。
- 围栏点开展开或块内滚动区。
- 更换围栏底层缓冲实现。
- Web、compact、工具预览窗数字。
