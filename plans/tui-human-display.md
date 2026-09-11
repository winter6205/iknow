# Plan: TUI 人读显示

**Goal:** 过程标题（英文 / `Thinking…` / 命令可见）、结束态一行（`Thought for` + 原第二行计数）、新建 10 行、编辑 diff、进度覆盖、位置常驻、滤 `<graph_mode>` 上屏。
**Approach:** 先改 `formatTurnActivityFold` / `formatThinkingFold` 焊成一行，再接线过程行与位置行。不改 ACI 注册名。与旧两行折叠、`思考了`、6 行、`[运行中]` 冲突时以 CONTEXT 本轮词条为准。
**Spec link:** `specs/tui-human-display.md`
**ACR:** all-yes（见 spec 文末）
**Tracker:** 本地 markdown
**Worktree:** `.iknow/worktrees/tui-human-display` on `feat/tui-human-display`
**SSOT:** 以**主仓**本文件 + `specs/tui-human-display.md` + `docs/CONTEXT.md` 为准。实现树里若仍是旧两行/`思考了`稿，先从主仓覆写再动手。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on `feat/tui-human-display`

```
bounded-context-guardian: yes — 只改 src/tui 人读投影与摘要；不新开 bounded context。
defensive-contract-validator: yes — SC 含空/负/溢/过程与落定/失败沿用 overlay。
error-handling-enforcer: yes — 无新失败政策。
complexity-anti-drift: yes — 摘要走注册表；位置行纯函数。
minimal-change-verifier: yes — 单一逻辑任务：TUI 人读；与 create-worktree 分票。
```

## 待写入

（空）

## Tasks (ordered by dependency)

1. **过程标题：英文 + 思考/命令可见** — tag: `[implementation]`
   - **Inherits:** spec D1 / `live tool line` — 无 `[运行中]`/`[完成]`；思考行 `Thinking…`（废 `思考中…`）；`Running N shell command(s)…` 且 **bash 命令可见**；search=query、fetch=url、read=path、grep=pattern。
   - **Surface:** TUI（`formatThinkingLive` / live 状态行 / 摘要）
   - **Acceptance:** SC1；running 帧含 `Thinking…` 或可见命令，不含中文过程括号。CLI 与 TUI 同一套 detail。
   - Status: [ ] pending
   - [parallel]

2. **结束态一行：时长 + 原第二行计数** — tag: `[implementation]`
   - **Inherits:** spec D2 — retract 计数焊进第一行，不得整段隐身、不得另起第二行。
   - **Surface:** TUI（`formatTurnActivityFold` / think-fold）
   - **Acceptance:** SC2；`formatTurnActivityFold` 返回至多 1 行 = `Thought for <duration>` 接上原第二行 `formatToolUseCounts`（含 `read_file × N`）；废「必须两行」与 `思考了 N 秒 · ran` 互斥闸。Skill 不进这行。
   - Status: [ ] pending
   - [blocks: T1]

3. **新建 10 行 / 编辑 diff / 挤档一行** — tag: `[implementation]`
   - **Inherits:** spec D3–D5；溢出文案英文 `+N more lines`；运行中 write 仍不摊 content。
   - **Surface:** TUI（完成预览纯函数 + 渲染）
   - **Acceptance:** SC3 + SC4；挤档只在「多写/子代理挤」路径，主会话默认预览仍在。
   - Status: [ ] pending
   - [parallel]

4. **进度同一行覆盖** — tag: `[implementation]`
   - **Inherits:** spec D6 — 百分比流不按行追加进气泡。
   - **Surface:** TUI（bash 结果预览 / live 输出）
   - **Acceptance:** SC5。
   - Status: [ ] pending
   - [parallel]

5. **位置行常驻：主仓也能画、绑树只换路径** — tag: `[implementation]`
   - **Inherits:** spec D7 / `session location chrome` — 底栏常驻 1 行，人读 `~/projects/iknow · master`（路径 · 分支，无 dirty/diff）。数据：未绑树用 `env_snapshot` 的 cwd+branch；绑了同一行换成树上路径（活 `taskRoot` 否则会话 `workspaceRoot`）。**禁止** `void envSnapshot` 后 0 行；**禁止** `isTaskWorktreePath` 决定显隐。子代理在下；不进焦点环。启动即有现势。
   - **Surface:** TUI chrome（`environment-pane` / `app.tsx` 行账）
   - **Acceptance:** SC6；主仓非 task 路径仍 1 行；改绑后同一槽换成 worktree 路径，不是多一行、也不是从无到有才出现。
   - Status: [ ] pending
   - [parallel]

6. **藏 `<graph_mode>`** — tag: `[implementation]`
   - **Inherits:** spec D8；与 agent_status 同隐藏函数。
   - **Surface:** TUI session-state（CLI 对等若有同一隐藏谓词则一起改）
   - **Acceptance:** SC7。
   - Status: [ ] pending
   - [parallel]

## 收尾

整轮 code review 对照 spec；`bun test tests/tui/` + `npm test`。不与 `plans/create-worktree-tools.md` 混 commit。
