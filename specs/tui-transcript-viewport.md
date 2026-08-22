# Spec: TUI transcript viewport mount

> 来源：操作员裁定 PR #592 尾窗理解错误（「消息过多才截」被做成「进场只挂最近 32 条」）；基线 = PR #591（`9dc7d60e`）的 ChatView 全量映射 + `specs/146-tui.md` 滚动纪律 + `docs/design/DESIGN-BANNER.md` 方案 B。
> 本 spec **不含实施代码**。下游 = `plans/tui-transcript-viewport.md`。

## Objective

长会话时 OpenTUI 保留模式树不能随 `session.messages` 线性膨胀（Yoga 对每个子节点做 layout；`viewportCulling` 只跳过绘制）。产品行为必须与主流 agent TUI（Claude Code `useVirtualScroll`、ChatGPT/Cursor 列表）一致：

- **滚动文档仍是全量历史**（含方案 B banner），用户上翻能看到第一条消息和眼睛；
- **树上只挂视口 + overscan** 里的条目，用 spacer 撑住 `scrollHeight`；
- **短会话与 #591 无差别**：内容能进视口的全部挂上，不出现「↑ N 条更早的消息」。

成功 = 撤销 #592 的固定条数尾窗后，长会话滚到顶能看到最早气泡与 banner；过长会话的 OpenTUI 子树规模跟视口走，不跟消息条数走。

## Background

PR #592（`ad9bf7e3`）把 ChatView 默认 `revealedCount = 32`，超出即换成 stub + PgUp 翻页。这是 **内容分页**，不是视口虚拟化。计划里写「对齐 Claude / Cursor / ChatGPT」把两件事揉在一起：那些产品按 **视口** 卸纤维，历史仍可连续滚回。

OpenTUI `ScrollBoxRenderable.viewportCulling` 不能当性能方案：它跳过 off-screen **draw**，不停 Yoga **layout**。#343 删 `MessageBlocksClipped` / 行账的前提仍然成立——禁止再估算 markdown 行数。高度只能来自挂载后的布局实测。

## Invariants

1. **Session 数据不变。** `TuiSessionState.messages` 仍是全量；本 spec 只约束 ChatView 往 OpenTUI 树挂什么。LLM `/compact` 正交，禁止当 UI 裁剪。
2. **方案 B banner。** banner 是滚动区第一段，与消息共享 scroll space，**不钉死**。视口在底部时允许卸下 banner；滚回顶部必须能再看到眼睛。禁止用 sticky chrome 替换方案 B。
3. **禁止行账。** 不得恢复 `markdown-lines` / `message-rows` / `row-window` / 按消息内容估算终端行数。未测高的条目用 **与内容无关的常量占位高度**；测过的高度来自 Yoga/`Renderable.height`。
4. **视口挂载，不是条数尾窗。** 挂载范围由 `scrollTop` + `viewport.height` + overscan 决定。overscan **至少一屏**。内容全部落在视口内时，行为与 #591 全量 `visibleMessages.map` 相同。
5. **Live tail 不进虚拟化集合。** 流式 thinking / draft / liveTool / askLine / spinner / crunched 行始终挂在消息列表之后（#590/#591 顺序不变）。
6. **Sticky 不变。** `<scrollbox stickyScroll stickyStart="bottom">`：追加贴底；用户上滚停止跟随；滚回底部恢复。`ChatViewHandle.scrollToBottom()` 仍在。
7. **没有「揭示更早一页」。** 删除 `revealOlder` / PgUp 翻页 / `↑ N 条更早的消息` stub。上翻 = 普通滚动。
8. **跟随官方滚动事件。** ChatView 通过 `verticalScrollBar.on("change")` 同步视口窗口。禁止劫持 `scrollTop` setter，禁止 rAF 轮询（sticky 生效前会读到 0）。

## Never do

- 默认只 mount 最近 N 条（任何固定 N，含 32/64/100）。
- 把 banner 钉在 scrollbox 外。
- 为让长会话测试通过而把「看不到最早消息」写成合格断言。
- 改 Web `MessageList`、session-api、compact。
- 把 banner `cols < 80` 短横幅降级塞进本 spec（独立缺陷）。
- 用 `Object.defineProperty` 补丁或 rAF 轮询跟踪 `scrollTop`。

## EXIT

| 输入                    | 行为                                             |
| ----------------------- | ------------------------------------------------ |
| `messages` 非数组       | 抛 typed `TypeError`（与错误尾窗函数同级纪律）   |
| 空会话                  | 不挂消息；banner（若有）仍可渲染；不崩           |
| `scrollTop` 非有限 / 负 | clamp 到 `[0, max(0, contentHeight - viewport)]` |
| 条目高度非有限 / ≤0     | 该条改用占位高度；不把会话渲成空白               |
| 条目数极大              | 挂载条数仍是视口+overscan，spacer 吸收其余高度   |

## Testing strategy

纯函数（视口窗口）必须覆盖 5 类边界：

- **empty**：0 条 → 空窗、spacer 0。
- **negative**：负 `scrollTop` / 非正高度 → clamp，窗口仍落在合法下标。
- **overflow**：远超视口的条数（至少三屏）→ 挂载区间长度 ≪ 总条数；`scrollTop=0` 的窗口含第一条；贴底窗口含最后一条。
- **concurrent**：纯函数两次调用互不影响。
- **exception**：`messages` 非数组 → `TypeError`。

ChatView 集成（相对 #592 更强，不得削弱）：

- 空会话不崩（既有 empty）。
- 短会话（内容不足一屏）无 stub，画面含全部可见消息。
- **100 条、滚到顶：含最早用户气泡，不含「条更早的消息」。**
- 贴底 sticky / `scrollToBottom` 既有测不倒退。

## Out of scope

- Web 消息列表虚拟化。
- LLM compact / 会话存储裁剪。
- banner 窄终端短横幅（`BANNER_MIN_COLS`）。
- live tail 进行中折叠（#589 已落地）。
- 恢复 ink 行账模块。
