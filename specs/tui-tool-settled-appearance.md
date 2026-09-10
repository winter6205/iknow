# Spec: TUI 工具落定态（留 / 收 / 点名着色）

> 下游 plan：`plans/tui-tool-settled-appearance.md`。
> 地图：`docs/wayfinder/tui-tool-settled-appearance-map.md`（G1–G5 已收口）。
> **Supersedes** `specs/tui-display-consistency.md` **D3**（整轮一律折叠、藏全部标题）。D1 外壳 / D2 thinkingMs / D4 窗与 ANSI / D7 注册表同置仍继承。
>
> **Amended 2026-09-10** by `specs/create-worktree-tools.md`（ADR-0082）：本文档正文的显示注册表键与 SC5 里的模型面工具名已改为 `create-worktree` / `enter-worktree` / `exit-worktree` / `remove-worktree` / `list-worktrees`（去 `-task`）；原名 `create-task-worktree` / `enter-task-worktree` / `exit-task-worktree` / `remove-task-worktree` / `list-task-worktrees` 只作历史对照，不再进模型面（`src/tui/tool-settled.ts` 消费新键）。D1 策略核 / D3 折叠语义 / D8 留收分类合同本身不变。

## Objective

TUI 在工具从 live 转为 idle 之后，按类决定可见性：人要核验的动作留下足迹，只给模型看的查询收回去，稀有能力用颜色和名字点出来。禁止再「整轮折成计数行、同时 `⎿` 预览还挂着」。

使用者是 TUI 最终用户。成功 = 落定后每一类工具的标题、预览、折叠计数、颜色由单一策略核派生，渲染层不再自己组合 `hideToolSummaries` 与预览。

## Boundaries

- **Does:**
  - **D1 策略核**：在 `src/tui/` 增加纯 TS 策略核（无 React）。先单文件 `tool-settled.ts`。导出 `deriveSlot(name, { running, failed })` → `{ showTitle, showPreview, inFoldCount, color }`，`color` ∈ `default | accent | error`。失败横切在核内最后一步。running 时全部逐条可见（`showTitle` 真、`inFoldCount` 假）。未知工具缺省 retract、无预览。
  - **D2 注册表一行**：`summary` + `preview?` + `settledClass`（keep / retract / accent）同置。缺 `settledClass` 的声明非法（测试拒绝）。建树四件必须进表：`create-worktree` / `enter-worktree` / `exit-worktree` / `remove-worktree`。
  - **D3 折叠只数成功的收**：折叠计数行只聚合 `inFoldCount === true`（成功且 retract）。留 / 点名着色 / 失败出独立标题行，不进计数。本轮零条收 → 不画工具计数行；思考秒数行可单独在（消费既有 **thinking duration**）。思考秒数与计数分行。retract 必须 `showTitle` 与 `showPreview` 同假。
  - **D4 留的足迹**：keep 成功：`bash` 留标题（命令）+ **result preview** 五行走 ANSI（行数不重开）；`write_file` / `edit_file` 留标题 + 既有 6 行预览；`bash_stop` / `todo_write` / `memory_save` 只留标题。
  - **D5 失败横切**：任意类失败 → 标题留、error 色、一行短错误（截断）、不进折叠计数、不画五行走 dim `⎿`。error 色优先于 accent。
  - **D6 点名着色**：accent 成功走现有 `accent` token + 人读表述（`skill <name>`；建树 / 进入 / 退出 / 删树带 label 或路径叶子）。禁止 dim。不把 skill 正文摊成五行走浅色预览。
  - **D7 渲染只消费 slot**：`turn-activity` 只按 `inFoldCount` 聚合；`message-blocks` / live 预览只按 `showTitle` / `showPreview` / `color` 画。删除「藏标题、留预览」的组合路径。
  - **D8 分类表（成功态）**：
    - keep：`bash`、`write_file`、`edit_file`、`bash_stop`、`todo_write`、`memory_save`
    - retract：`read_file`、`grep`、`glob`、`web_search`、`web_fetch`、`memory_recall`、`tool_search`、`skill_search`、全部 `lsp_*`、`bash_output`、`list_mcp_resources`、`read_mcp_resource`、`query_trace`、`list-worktrees`；未注册工具缺省 retract
    - accent：`skill`、`create-worktree`、`enter-worktree`、`exit-worktree`、`remove-worktree`
    - 不进三类：`spawn_subagent` / `subagent_result` 沿用独立 glyph

- **Confirms with human:** (none — assumption gate 2026-09-04 已清)

- **Out of this spec:**
  - web 端同一套落定规则
  - Ctrl+O / 展开折叠快捷键
  - 子代理 glyph 重切
  - `create-worktree` ACI 形状、门禁说明书、worktree isolation 开关
  - 模型上下文、tool_result 编码、meta 进模型
  - live 流式协议；running 仍逐条可见
  - 重开 bash ANSI 透传、五行走行数、`read_file` 内容预览、write/edit 六行窗
  - 新开仓库级 bounded context；`src/tui/services/` / `utils/` / 预先建 `tool-display/`

## Success Criteria

- **SC1（核单一派生）**：`deriveSlot("read_file", { running: false, failed: false })` 为 `{ showTitle: false, showPreview: false, inFoldCount: true, color: "default" }`；同输入 `failed: true` 则为 `{ showTitle: true, showPreview: false, inFoldCount: false, color: "error" }`。命令：`bun test tests/tui/`（策略核表测）。
- **SC2（五类边界，策略核表测）**：
  - empty：本轮零工具 → 无折叠计数行；`deriveSlot` 不在无 name 时被调用（调用方空列表）。
  - negative：未注册名 → retract、`showPreview` 假、不进 keep/accent。
  - overflow：≥20 条成功 retract → 仍一行计数（各 name × N），不摊成 ≥20 条标题。
  - concurrent：`running: true` 时任意 name 的 `inFoldCount` 假、`showTitle` 真（live 与 idle 互不串）；纯函数无共享可变状态，`// N/A: pure deriveSlot`。
  - exception：失败横切见 SC1 第二断言与 SC4。
- **SC3（收不残留预览）**：idle 一轮含成功 `read_file` + 成功 `bash`：画面有 bash 标题（及成功时五行走），无 read 标题、无 read `⎿`；折叠计数含 `read_file × 1`、不含 `bash`。命令：`bun test tests/tui/chat-view-thinking-tool-fold.test.tsx tests/tui/turn-activity.test.ts`。
- **SC4（失败不进计数、不 dim 长文）**：idle 一轮含失败 mutate（如 `[worktree_isolation]` 长回执）：有红标题 + 一行短错误；无 dim 五行走 `⎿` 堆该文；折叠计数不含该失败件。命令：同上 + 策略核表测。
- **SC5（点名非 dim）**：成功 `skill` / `create-worktree` 落定行走 `accent`，有人读表述，无五行走 skill 正文预览。命令：`bun test tests/tui/`。
- **SC6（注册表完备）**：`EXPECTED_TOOLSET_*` 与显示注册表每一件都有 `settledClass`；建树四件在表内。命令：`bun test tests/tui/deps-tools.test.ts tests/tui/tool-summary.test.ts`。
- **SC7（rg 闸）**：`rg -n "hideToolSummaries" src/tui/` 零命中（组合路径删除，改走 slot）。
- **SC8（回归）**：`npm test` 全绿。

## Open Questions

(none)

## Inherits / Changes

**Quotes（CONTEXT.md 原文）：**

- **settled appearance（落定态）**: TUI 里工具从 live 转为 idle 之后的可见性策略——按类留下足迹、收回去、或点名着色。不是「有已完成工具就整轮折成计数行」。
- **keep class（留）**: 落定后仍画出标题行的工具类（bash / write / edit / 会话动作）。bash 成功时标题带命令，并可带结果预览五行走；其它留类默认只留标题。
- **retract class（收）**: 落定后标题和预览都从屏幕拿掉、只进折叠计数的工具类（读取 / 搜索 / 查询）。未知未注册工具缺省也是收。
- **accent class（点名着色）**: 落定后以非 dim 的 `accent` 色 + 人读表述留在屏幕上的特定能力（skill、task worktree 生命周期工具）。必须进显示注册表。
- **failure overlay（失败横切）**: 任意落定类在失败时覆盖成功态分类——留标题、一行短错误、error 色、不进折叠计数、不用 dim `⎿` 堆长文。error 色优先于 accent。
- **result preview（结果预览）**: 工具调用标题行下方的截断输出块——`⎿` 风格前缀、上限 5 行、bash 取尾部、ANSI 透传。只画在 **keep class** 的成功 bash 上；dim 仅用于装饰元素（`⎿` 前缀、`… +N 行` 溢出），正文行（stdout/stderr）走正文色 token，不藏失败或点名着色。
- **thinking duration（思考时长）**: assistant 消息的落盘属性——adapter 流式路径测量（首条 `thinking_delta` 至首个非思考增量），`thinkingMs` 经 commit 钩子随事件链落盘；折叠簇时长 = 簇内消息求和。非 UI 测量值。

**Inherits：**

- ADR-0037：本 spec 不改门禁、不改 ACI 形状、不改 `unboundMutateNotice` 文案。
- `specs/tui-display-consistency.md` D1 外壳、D2 thinkingMs 落盘、D4 五行走/ANSI/`read_file` 无内容预览/write·edit 六行、D7 摘要与预览同置（本 spec 把 `settledClass` 加进同一行）。
- 测试栈：bun:test `tests/tui/`；`EXPECTED_TOOLSET_*`；`testRender` / `captureCharFrame`。
- 色板：`tuiPalette.accent` / `tuiPalette.error` / `tuiPalette.dim`（dim 仅成功 bash 尾巴）。

**Changes：**

- 新增策略核与 `deriveSlot`；注册表加 `settledClass`；折叠语义从「整轮藏标题」改为「只数成功的收」。
- **Supersede** 旧 D3。
- 建树四件进入显示注册表。
- 删除 `hideToolSummaries` 组合路径。

**待写入：** （空 — 词条已在 CONTEXT.md）

## ACR

```
bounded-context-guardian: yes — 落点在既有 TUI 能力 `src/tui/tool-settled.ts`，不新开仓库级 context，禁止 services/utils/tool-display 预拆。
defensive-contract-validator: yes — SC2 覆盖 empty / negative / overflow / concurrent（pure N/A）/ exception（SC1/SC4）。
error-handling-enforcer: yes — 失败横切在核最后一步返回 typed slot（error 色、不抛、不 null）；未知工具走 retract；缺 settledClass 测试拒绝。
complexity-anti-drift: yes — deriveSlot 核 + 一行注册表 + 渲染只消费 slot；overlay 不进 JSX。
minimal-change-verifier: yes — 单一逻辑任务：落定态（核 + settledClass + 折叠改语义 + 删 hideToolSummaries + D3 supersede）。
```

OVERALL: PASS — 下一步 writing-plans。
