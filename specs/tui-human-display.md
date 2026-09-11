# Spec: TUI 人读显示（过程标题 / 收成计数 / 写改预览 / 位置行）

> 下游 plan：`plans/tui-human-display.md`。
> LogicSync 2026-09-10 收口。与旧显示数字冲突时以本轮 CONTEXT 词条为准。
> **Amends** `tui-tool-settled-appearance.md` D4 写/改 6 行窗、过程行 `[运行中]` 文案；**不**重开 D1 策略核 / D8 留收分类。
> **Amends** `tui-display-consistency.md` 工具状态行「`[运行中]/[完成]`」拼装合同（人读过程行不再带状态括号）。

## Objective

TUI 把噪音和必须看见的信息分开。过程中工具是英文「名 + 要点」（思考 `Thinking…`，命令可见）；结束态一行 `Thought for <duration>` 接上原第二行 `name × N`（含收类，不得整段隐身）；新建文件看 10 行；编辑必须看见本次 diff；进度同一行覆盖；底栏位置行常驻。使用者是 TUI 操作员。

## Boundaries

- **Does:**
  - **D1 过程标题**：running 画 `live tool line`——英文；思考 `Thinking…`；`Running` 的命令可见。无 `[运行中]` / `[完成]`。`web_search`+查询、`web_fetch`+URL、`read_file`+路径、`grep`+模式、`bash`+命令。CLI 与 TUI 共用摘要函数。
  - **D2 收类不得蒸发**：`read_file` / `grep` / `web_search` / `web_fetch` 等 retract 过程中有 D1 行；落定后计数仍在，只是焊进结束态**第一行**（与 `Thought for` 同行），不是另起第二行、也不是整段隐身。无正文预览。无过程行且无计数 = 不合格。
  - **D3 新建预览**：`write_file` 空→有：前 10 行 + `+N more lines`（N = 被截去的行数；`previewOverflowLabel` 是唯一文案 SSOT）。运行中仍不摊 `content`。
  - **D4 改动 diff**：`edit_file` / 覆盖已有文件：画本次 diff，不套 D3 的 10 行帽。
  - **D5 挤档**：同一轮连写很多或子代理挤视图可只留 `Wrote N lines to path`；主会话默认走 D3/D4。
  - **D6 进度覆盖**：`1%`→`100%` 同类流同一行原地更新，落定不留百分比史。
  - **D7 位置行**：底栏常驻一行，人读 `~/projects/iknow · master`。绑树只把路径换成 worktree 根，仍一行。不决定显隐。子代理行在它下面。不进 Down/Up 焦点环。不带 dirty/diff。启动即有现势（mount 或首拍 `env_snapshot`），不得 `void envSnapshot` 后 0 行。
  - **D8 滤 `<graph_mode>`**：`isTuiHiddenUserMessage`（及 CLI 对等）藏 `<graph_mode>`，与 `<agent_status>` 同纪律。
- **Confirms with human:** (none — LogicSync 已清)
- **Out of this spec:**
  - 工作树 ACI 改名 / description / 夹具（`specs/create-worktree-tools.md`）。
  - harness 图现势每个 `run()` 一次（ADR-0081）；本票只滤人读标记。
  - 思考直播秒数（进行中只写 `Thinking…`；时长只在结束态 `Thought for`）。
  - web 端同一套人读规则。
  - 重开 retract/keep/accent 分类表；`read_file` 内容预览。
  - 调研对象名写入仓库文件。

## Success Criteria

- **SC1（过程行无状态括号）**：running `read_file` / `grep` / `web_search` 帧不含 `[运行中]` / `[完成]`，含路径或查询/模式。命令：`bun test tests/tui/`。
- **SC2（收类可见）**：成功 `read_file` idle 帧与 `Thought for` **同一行**含 `read_file × N`，无第二行计数、无文件正文预览；running 帧有过程行。不得两帧都空白。
- **SC3（新建 10 行）**：`completedToolPreview("write_file", 新建)` 可见 10 行、`hiddenLineCount` 为其余；旧 6 行闸改掉。
- **SC4（编辑是 diff）**：`edit_file` 完成预览 `kind: "diff"`（或等价红绿行），不套 10 行正文头。
- **SC5（进度不堆行）**：同一 bash 百分比流人读面不出现 ≥2 条历史百分比行。
- **SC6（位置常驻）**：主仓 + 非 task 路径仍渲染 1 行位置；绑树后同一槽换路径。`worktreeIsolationLines` 仅 task 才显示的合同作废。
- **SC7（滤图标记）**：transcript 含 `<graph_mode>` user 消息时，TUI 帧无该标签、不当 ❯。
- **SC8（回归）**：`bun test tests/tui/` 绿；`npm test` 全绿。

## Open Questions

(none)

## Inherits / Changes

**Quotes（CONTEXT.md）：**

- **live tool line（过程标题）** / **unit fold**：进行中英文过程行；结束态一行 = `Thought for` + 原第二行 `formatToolUseCounts`。
- **retract class（收）**: 落定后标题和预览都从屏幕拿掉、只进折叠计数的工具类（读取 / 搜索 / 查询……）。
- **write create preview（新建预览）**: 新建文件落定后挂正文前 10 行 + `+N more lines`（CONTEXT 词条已定为英文形态，旧中文溢出文案作废）。
- **edit diff preview（改动 diff）**: 编辑/覆盖已有文件时，人必须看见**本次改动**的 diff，不套新建那 10 行帽。
- **progress tick（进度覆盖）**: `1%`→`100%` 这类过程流只在同一行原地更新。
- **session location chrome（会话位置行）**: TUI 底栏**常驻一行**……绑 task worktree 只**切换**这一行上的路径/身份。
- **必须看见 vs 噪音** / **本轮人读合同 vs 旧显示数字**。

**Inherits：** `deriveSlot` / 注册表 / `TOOL_SETTLED_CLASS`；`thinking duration` 落盘不改；`fence display cap` 32 行不动；测试 `bun test tests/tui/`。

**Changes：** `TOOL_PREVIEW_WINDOW` 6→新建 10；编辑不共用该帽；废 `[运行中]` 过程文案；废「仅 task 路径才画位置行」；藏 `<graph_mode>`。

**待写入：** (空 — 词条已 persist)

## architecture-change-reviewer

```
bounded-context-guardian: yes — 只改 src/tui 人读投影与摘要；不新开 bounded context。
defensive-contract-validator: yes — SC 含空/负/溢/过程与落定并发/失败横切沿用既有 failure overlay。
error-handling-enforcer: yes — 无新失败政策；预览空 → 不画块（既有 EXIT）。
complexity-anti-drift: yes — 摘要仍走注册表；位置行纯函数投影；不把进度状态机做进 JSX。
minimal-change-verifier: yes — 单一逻辑任务：TUI 人读合同（与 ACI 改名分票）。
```
