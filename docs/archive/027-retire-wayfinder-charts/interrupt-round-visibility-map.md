> **ARCHIVED** — 只读留档；活契约见 `docs/archive/027-retire-wayfinder-charts/README.md`。

# wayfinder:map — 打断后本轮去哪了

> Tracker: 本地 markdown（本 run 未点名 GitHub issue）
> Charted: 2026-09-19
> 图名（人读引用时用全名，不要用裸 id）：**打断后本轮去哪了**

## Destination

定位 Esc **前台打断** 之后「本轮从屏幕上没了」分别落在哪一层（TUI 瞬时渲染 / 权威 messages·transcript / **in-flight closeout** keep），并裁定三面可见性：打断当下的 TUI、重开会话、下一句进模型。到达标志：能一句话说清现状组合，以及产品要的 keep 与现状是否一致。不到「已经修好」。

**Handoff（2026-09-19）**：地图到达。keep 已合入 `master`（[#1064](https://github.com/winter6205/iknow/pull/1064)）。契约 [`interrupt-frozen-prefix-keep`](../../specs/interrupt-frozen-prefix-keep.md)；plan [`interrupt-frozen-prefix-keep`](../../plans/interrupt-frozen-prefix-keep.md)；ADR-0108。R1 仍是改前现状备忘。

## Notes

**domain**：TUI 聊天墙 + session-api 权威历史 + Loop Engine closeout。不改键位（Esc / Ctrl+C 复制臂已迁）。「内存」在本图 = 权威 messages / transcript，不是 iknow-memory MCP。

**每个 session 开工前必读的 skill**：

- `arthurpower:logicsync` —— grilling 默认
- `arthurpower:domain-modeling` —— G1 已改写 closeout（ADR-0108 / CONTEXT 已落）

**tracker**：本地 markdown，本文件即地图；票体在 `docs/wayfinder/tickets/`。

**本图必须尊重的既有决策**（票内明确点名挑战者除外）：

- **前台打断** —— Esc 停本会话全部前景；Ctrl+C 只复制
- **in-flight closeout** —— ADR-0108：模型在途留下 freeze 前缀；工具在途 assistant 已追加、在途 tool 填 `cancelled`
- **interrupt system message** —— 盘上可留 `Interrupted by user.`；`/continue` 本次 prior 可去掉末尾这句
- **user-turn keep on protocol failure** —— 只覆盖 protocolError / emptyFinalResponse，不自动覆盖 cancelled
- **TUI 工具落定态** —— 已清图；本图不重开留/收/点名着色
- **handoff** —— 已合入 `master`（#1064）：`specs/interrupt-frozen-prefix-keep.md` + `plans/interrupt-frozen-prefix-keep.md` + ADR-0108

**Destination 选定**（2026-09-19 操作员 Confirm Recommend）：定位 + 裁定三面可见性，不是「只要定位」，也不是未定位就当 bug 修。

## Decisions so far

- [R1 closeout 与权威历史丢掉什么](tickets/r1-interrupt-closeout-store.md) — _现状（改前）_：cancelled 不丢 user；模型在途不落 assistant，仍写 interrupt；工具在途保留 assistant + cancelled tool_result。
- [R2 TUI 是否另清 live 缓冲](tickets/r2-interrupt-tui-live-buffer.md) — 有独立 live overlay；Esc 当下不清；settle 卸流式并改画文件快照。
- [G1 三面可见性契约](tickets/g1-three-surface-visibility.md) — 钉住块留下、只截 `tailRaw`；三面对齐权威历史；无 prefix 可以没有 assistant。ADR-0108。
- [G2 不一致时改哪一层](tickets/g2-which-layer-to-change.md) — closeout 必须 commit 前缀；TUI 卸 overlay 改画快照；freeze 函数共用，禁止只改墙。

## Not yet specified

（空。continue 仍只剥末尾 interrupt；前景子代理同一 freeze 刀；cancelled 工具继续走落定失败横切。）

## Out of scope

- 把打断键改回 Ctrl+C，或改 chat 视图外 Esc 的面板语义
- 本图直接改产品代码（keep 已由 #1064 落地，不在本图重开）
- timeout 专属产品文案（可与 cancelled 共用 closeout 代码，但不在本图重开 timeout 体验）
- iknow-memory MCP / dream / GC

## Tickets

阻塞用正文 `Blocked by:`。

| 票                                                                       | 类型     | 问题                                       | 阻塞   |
| ------------------------------------------------------------------------ | -------- | ------------------------------------------ | ------ |
| [R1 closeout 与权威历史丢掉什么](tickets/r1-interrupt-closeout-store.md) | research | 模型在途 vs 工具在途，store/盘上各留什么   | —      |
| [R2 TUI 是否另清 live 缓冲](tickets/r2-interrupt-tui-live-buffer.md)     | research | 聊天墙是否独立于 store 把本轮画没          | —      |
| [G1 三面可见性契约](tickets/g1-three-surface-visibility.md)              | grilling | 打断当下 / 重开 / 下一句进模型各该看见什么 | R1, R2 |
| [G2 不一致时改哪一层](tickets/g2-which-layer-to-change.md)               | grilling | 只改 TUI、只改 closeout，还是两层都改      | G1     |

Frontier：空。图已清决策。落地见 #1064 / ADR-0108。
