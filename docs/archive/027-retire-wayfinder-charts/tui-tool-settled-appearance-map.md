> **ARCHIVED** — 只读留档；活契约见 `docs/archive/027-retire-wayfinder-charts/README.md`。

# wayfinder:map — TUI 工具落定态：哪些留、哪些收、哪些点名着色

> Tracker: 本地 markdown（用户裁定不开 GitHub issue；skill 默认 tracker 的 fallback 形态）
> Charted: 2026-09-04 · Cleared: 2026-09-04（G1–G5 收口；执行以讨论事实为准，对照原文不入库）
> 图名（人读引用时用全名，不要用裸 id）：**TUI 工具落定态：哪些留、哪些收、哪些点名着色**

## Destination

让 TUI 在工具 **live 结束之后** 按类决定可见性：该留的留足迹（例如 bash 做了什么），该收的从屏幕收回去（例如读取），该点名的用颜色或表述标出来（例如 skill、create-task-worktree），而不是整轮一律折成计数行、同时 `⎿` 预览还挂着。

到达标志：每一类工具在落定后有明确规则（留 / 收 / 点名着色）；现有 D3「有已完成工具就整轮折叠」被这张图改写；D4 能继承的继承（bash ANSI 透传已定，不再重开）。

## Notes

**domain**：TUI 显示（`src/tui/chat-view.tsx` / `message-blocks.tsx` / `tool-summary.ts` / `turn-activity.ts` / `completed-tool-preview-view.tsx`）。不改模型视野、不改 tool_result 编码。

**每个 session 开工前必读的 skill**：

- `arthurpower:logicsync` —— 所有 grilling 票的默认工作方式
- `arthurpower:domain-modeling` —— 落定三类已收口，词条见 `docs/CONTEXT.md`
- 动 `src/tui` 显示注册表时过 `complexity-anti-drift` / `minimal-change-verifier`

**tracker**：本地 markdown，本文件即地图 + 票。禁止开 GitHub issue。

**调研与执行（用户 2026-09-04 裁定）**：

- 对照调研**只在对话里做**，禁止写入仓库任何文件。
- **执行以讨论事实为准**，不以对照调研为 SSOT。本图 Decisions so far 只记决议，不记对照原文。

**本图必须尊重的既有决策**（票内明确点名者除外）：

- **D4 · bash ANSI 透传** —— 继承，不重开。
- **D4 · `read_file` 不显示内容预览** —— 继承；「收」不是把正文留下来。
- **D4 · 5 行结果窗 / write·edit 6 行预览的行数** —— G3 不重开行数，只定落定后还显不显。
- **ADR-0037** —— 本图只问 TUI 怎么显，不改 ACI 形状、不改门禁说明书。

**handoff**：图已清空。SPECIFY 已在 worktree `worktree-tui-tool-settled-appearance` 落地：`specs/tui-tool-settled-appearance.md` + `plans/tui-tool-settled-appearance.md`。ACR all-yes。旧 D3 已在 `specs/tui-display-consistency.md` / `plans/tui-display-consistency.md` 标明 superseded。

## Decisions so far

- **R1 · 对照面调研（对话内，不落文件）** — 调研在对话完成；原文不进仓库。执行以 G1–G4 为准。
- **G1 · 落定三类怎么切** — 成功态切「留 / 收 / 点名着色」；失败是横切不是第四类工具表。见票内 Resolution。
- **G2 · 折叠行在三类并存时还干什么** — 折叠计数只统计成功的「收」；留 / 点名 / 失败出独立行；收必须连预览一起拿掉。
- **G3 · 「留」的足迹长什么样** — bash 留标题（命令）+ 成功时 D4 五行走 ANSI；失败留标题 + 一行短错误（error 色），不用 dim `⎿` 堆长文。
- **G4 · 点名着色的视觉语言** — `accent` 色 + 人读表述；禁止 dim；失败横切时 error 色优先。skill / 建树生命周期进显示注册表。
- **G5 · 落定策略的模块切分** — 不新开仓库级 bounded context。TUI 内抽纯函数策略核 `tool-settled`：一类一行注册表 + `deriveSlot` 单一派生；折叠/渲染只消费 slot，禁止再各自决定藏标题还是留预览。

## Tickets

> 本地 fallback：一票一节。`state` 取 open / blocked / claimed / closed。

### R1 · 对照面调研（对话内，不落文件）

- type: `research` · state: **`closed`**（2026-09-04）· blocked-by: —

**## Question**

现行折叠 + 结果预览在落定后实际画出什么？对照面怎么收？只为 G1–G4 开口，不产规范。

**## Resolution**

调研在对话里完成，原文不落仓库。执行以 G1–G4 讨论为准。

### G1 · 落定三类怎么切

- type: `grilling` · state: **`closed`**（2026-09-04）· blocked-by: —

**## Question**

「留 / 收 / 点名着色」怎么切完整张工具表？失败是不是第四类？`create-task-worktree` 进不进注册表？

**## Resolution**

判据（讨论事实）：live 结束后，人要核验的动作留下；只给模型看的查询收回去；稀有能力点名着色。失败不是第四类工具，是横切：任意类失败都留，不跟成功走「收」。

**留（成功）**：`bash`、`write_file`、`edit_file`、`bash_stop`、`todo_write`、`memory_save`。

**收（成功）**：`read_file`、`grep`、`glob`、`web_search`、`web_fetch`、`memory_recall`、`tool_search`、`skill_search`、全部 `lsp_*`、`bash_output`、`list_mcp_resources`、`read_mcp_resource`、`query_trace`、`list-task-worktrees`。未进注册表的未知工具缺省也是收，且无预览。

**点名着色（成功）**：`skill`、`create-task-worktree`、`enter-task-worktree`、`exit-task-worktree`、`remove-task-worktree`。这些必须进 `TOOL_DISPLAYS`（今天缺席的建树件要补上）。

**不进三类**：`spawn_subagent` / `subagent_result` 沿用现有独立 glyph，本图不重切。

**失败横切**：标题留下、进独立行、不进折叠计数。形态见 G3。

### G2 · 折叠行在三类并存时还干什么

- type: `grilling` · state: **`closed`**（2026-09-04）· blocked-by: G1

**## Question**

三类并存时折叠行还在不在？统计谁？思考秒数还绑不绑？

**## Resolution**

折叠行还在，但只统计**成功且被收**的工具（例如 `read_file × 3 · web_fetch × 1`）。

- 留 / 点名着色 / 失败：出自己的标题行，**不**出现在计数里。
- 本轮零条「收」：不画工具计数行；思考秒数行仍可单独在。
- 思考秒数与工具计数继续分行，不粘成一行。
- 「收」必须同时拿掉标题**和**预览。禁止再出现「标题藏了、`⎿` 还挂着」。
- running 仍逐条可见；本票不改 live。

改写旧 D3「有已完成工具就整轮折叠、藏全部标题」。

### G3 · 「留」的足迹长什么样

- type: `grilling` · state: **`closed`**（2026-09-04）· blocked-by: G1

**## Question**

「留」落定后留下标题、输出尾巴，还是只要命令？失败怎么显？

**## Resolution**

bash「做了什么」= **命令标题必须留**。成功时额外继承 D4：五行走 ANSI 尾部（行数不重开）。write / edit 留标题 + 既有 6 行预览。其它「留」（`todo_write` / `memory_save` / `bash_stop`）只留标题，不摊正文。

失败（横切）：标题标红 + **一行**短错误（截断），颜色走 error，不用 dim 的 `⎿` 堆门禁长文。不把失败输出画成五行走预览。

### G4 · 点名着色的视觉语言

- type: `grilling` · state: **`closed`**（2026-09-04）· blocked-by: G1

**## Question**

skill / 建树落定后用颜色、表述，还是两者？和失败红怎么分层？

**## Resolution**

两者都要：现有 `accent` token + 人读表述（`skill <name>`；建树 / 进入 / 退出 / 删树带 label 或路径叶子）。禁止 dim。不把 skill 正文摊成五行走浅色预览。

失败横切时 **error 色优先于 accent**，避免「显眼的都是红的」和「失败也点名成品牌色」混在一起。

本票不改 skill / 建树的 ACI 行为。

### G5 · 落定策略的模块切分

- type: `grilling` · state: **`closed`**（2026-09-04）· blocked-by: G1–G4

**## Question**

落定三类 + 失败横切落地时，代码怎么切模块才稳健？要不要新开 bounded context？

**## Resolution**

不新开仓库级模块。显示仍属 `src/tui/`。禁止按 `services/` / `utils/` 切层。

TUI 内增加**策略核**（纯 TS，无 React）：

- 注册表一行声明：`summary` + `preview?` + `settledClass`（keep / retract / accent）。缺席工具缺省 retract、无预览。
- `deriveSlot(name, { running, failed })` 是唯一派生：产出 `{ showTitle, showPreview, inFoldCount, color }`。失败横切在核内最后一步，不在 JSX 里重写。
- `turn-activity` 只聚合 `inFoldCount === true` 的成功收类；`message-blocks` / live 预览只渲染 slot，不再自己解 `hideToolSummaries` 与预览的组合。

覆盖闸：工具集名单必须带 `settledClass`；缺建树件或核与渲染不一致 → 测试失败。先单文件 `src/tui/tool-settled.ts`；超过复杂度软门再拆目录，不预先建 `tool-display/`。

## Not yet specified

（空：G1–G5 已把本图内可钉的雾收完。）

## Out of scope

- **开 GitHub issue** —— 用户裁定；本图只活在本文件。
- **把调研原文写入仓库** —— 用户裁定；对照只在对话。
- **重开 bash ANSI 透传** —— D4 已定。
- **给 `read_file` 加内容预览** —— D4 已禁。
- **改 `create-task-worktree` 的 ACI 参数 / 生命周期 / 门禁说明书** —— 本图只问 TUI 怎么显。
- **关掉 worktree isolation** —— 显示问题不是关隔离。
- **模型上下文、tool_result 编码、meta 旁路进模型** —— 显示层。
- **live 流式协议 / adapter 事件** —— destination 是落定后可见性；running 逐条可见继承。
- **web 端是否跟同一套落定规则** —— destination 是 TUI；web 另开图或跟 spec 时再钉。
- **子代理 glyph 重切进三类** —— 沿用 `▣/✓/✗`。
- **展开/折叠快捷键** —— 旧 spec 已留到下一轮；本图不收。
