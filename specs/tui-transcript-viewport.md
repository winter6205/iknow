# Spec: TUI transcript viewport mount

> 来源：操作员裁定 PR #592 尾窗理解错误（「消息过多才截」被做成「进场只挂最近 32 条」）；基线 = PR #591（`9dc7d60e`）的 ChatView 全量映射 + `specs/146-tui.md` 滚动纪律 + `docs/design/DESIGN-BANNER.md` 方案 B。
> 本 spec **不含实施代码**。下游 = `plans/tui-transcript-viewport.md`。

## Objective

长会话时 OpenTUI 保留模式树不能随 `session.messages` 线性膨胀（Yoga 对每个子节点做 layout；`viewportCulling` 只跳过绘制）。产品行为必须与主流 agent TUI（Claude Code `useVirtualScroll`、ChatGPT/Cursor 列表）一致：

- **滚动文档仍是全量历史**（含方案 B banner），用户上翻能看到第一条消息和眼睛；
- **树上只挂视口 + overscan** 里的条目，用 spacer 撑住 `scrollHeight`；
- **短会话与 #591 无差别**：内容全部落在视口 + overscan 内的全部挂上，不出现「↑ N 条更早的消息」；挂载窗口本身可以短于总条数，只要区间换算结果与全量 map 一致。

成功 = 撤销 #592 的固定条数尾窗后，长会话滚到顶能看到最早气泡与 banner；**任何**会话的 OpenTUI 子树规模跟视口走，不跟消息条数走（含总高一屏到八屏之间的会话）。滚动提交按量化步长节流，亚阈值连续滚动不逐像素提交整棵 ChatView。

## Background

PR #592（`ad9bf7e3`）把 ChatView 默认 `revealedCount = 32`，超出即换成 stub + PgUp 翻页。这是 **内容分页**，不是视口虚拟化。计划里写「对齐 Claude / Cursor / ChatGPT」把两件事揉在一起：那些产品按 **视口** 卸纤维，历史仍可连续滚回。

OpenTUI `ScrollBoxRenderable.viewportCulling` 不能当性能方案：它跳过 off-screen **draw**，不停 Yoga **layout**。#343 删 `MessageBlocksClipped` / 行账的前提仍然成立——禁止再估算 markdown 行数。高度只能来自挂载后的布局实测。

## Invariants

1. **Session 数据不变。** `TuiSessionState.messages` 仍是全量；本 spec 只约束 ChatView 往 OpenTUI 树挂什么。LLM `/compact` 正交，禁止当 UI 裁剪。
2. **方案 B banner。** banner 是滚动区第一段，与消息共享 scroll space，**不钉死**。进场眼睛在；消息变长把它顶出当前视口是预期，不是回归；上翻必须还能看见。禁止用 sticky chrome 替换方案 B，禁止把「贴底时看不见 banner」写成缺陷。
3. **禁止行账。** 不得恢复 `markdown-lines` / `message-rows` / `row-window` / 按消息内容估算终端行数。未测高的条目用 **与内容无关的常量占位高度**；测过的高度来自 Yoga/`Renderable.height`。
4. **视口挂载，不是条数尾窗。** 挂载范围由 `scrollTop` + `viewport.height` + overscan 决定，**不看内容总高**：禁止「内容高度低于 N 个视口则全量挂载」这类短路（任何固定 N 屏）。overscan **小于一屏**（默认取视口的固定分数并量化为亚屏常数；缺失 / 非有限 / 显式值小于默认时取默认，显式更大的值原样尊重）。内容全部落在 **视口 + overscan** 内时，行为与 #591 全量 `visibleMessages.map` 相同——挂载区间换算结果一致，不因走窗口路径而变化。
5. **Live tail 不进虚拟化集合。** 流式 thinking / draft / liveTool / askLine / spinner / crunched 行始终挂在消息列表之后（#590/#591 顺序不变）。
6. **Sticky 不变。** `<scrollbox stickyScroll stickyStart="bottom">`：追加贴底；用户上滚停止跟随；滚回底部恢复。`ChatViewHandle.scrollToBottom()` 仍在。
7. **没有「揭示更早一页」。** 删除 `revealOlder` / PgUp 翻页 / `↑ N 条更早的消息` stub。上翻 = 普通滚动。#592 旧测冻结在 `archive/tui-transcript-mount-window/` 与 `archive/tui-592-chat-view-scroll/`，禁止迁回 `tests/tui/`。
8. **跟随官方滚动事件。** ChatView 通过 `verticalScrollBar.on("change")` 同步视口窗口。禁止劫持 `scrollTop` setter，禁止 rAF 轮询（sticky 生效前会读到 0）。允许对 React 状态提交做**量化节流**：连续亚阈值 `change` 不各自 `setScrollTop`，跨越量化步长或贴底/置顶仍必须提交；首次提交与置顶必须立即生效，保证滚到顶能看到第一条、贴底不滞后。

## Never do

- 默认只 mount 最近 N 条（任何固定 N，含 32/64/100）。
- 把 banner 钉在 scrollbox 外。
- 把「贴底时看不见 banner / 眼睛被消息顶走」当成回归去修。
- 把 #592 归档测试迁回 `tests/tui/`（`archive/tui-transcript-mount-window/`、`archive/tui-592-chat-view-scroll/`）。
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
- **overflow**：远超视口的条数（至少三屏）→ 挂载区间长度 ≪ 总条数；`scrollTop=0` 的窗口含第一条；贴底窗口含最后一条。另加：总高超过一屏但低于旧实现的固定 N 屏短路（已删除）的会话同样按视口切片；内容全部落在视口 + overscan 内时与全量 map 等价。
- **concurrent**：纯函数两次调用互不影响。
- **exception**：`messages` 非数组 → `TypeError`。
- **overscan / 提交量化**：`viewport.height >= 2` 时默认 overscan 恒 `< viewport.height`；`viewport.height <= 1` 为退化情形（不存在「小于一屏」的正 overscan，取可达最小值 1 行，不得读成「恒小于一屏」，测试须显式钉住该值）；量化步长 ≥1、≤ 一滚轮步长、≤ 默认 overscan；亚阈值 `change` 不提交、跨步长 / 贴底 / 置顶提交。换会话（`conversationId` 变化）后首次 `change` 必须提交。

ChatView 集成（相对 #592 更强，不得削弱）：

- 空会话不崩（既有 empty）。
- 短会话（内容不足一屏）无 stub，画面含全部可见消息；内容超过一屏但短于旧全挂阈值时，滚到顶仍含最早消息、贴底仍含最末消息（窗口量化提交不得让首末可见性滞后）。
- **100 条、滚到顶：含最早用户气泡，不含「条更早的消息」。**
- 贴底 sticky / `scrollToBottom` 既有测不倒退。

## Out of scope

- Web 消息列表虚拟化。
- LLM compact / 会话存储裁剪。
- banner 窄终端短横幅（`BANNER_MIN_COLS`）。
- live tail 进行中折叠（#589 已落地）。
- 恢复 ink 行账模块。
