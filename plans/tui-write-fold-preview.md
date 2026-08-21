# Plan: TUI write/edit 完成后折叠预览

**Goal:** `write_file` / `edit_file` 落盘成功后，对话里立刻以截断预览钉住（新文件看代码、改已有文件看 diff）；生成中仍只显示运行中摘要，不画 `content` 正文。
**Approach:** 先抽出「完成态预览」纯函数（分类 + 截断），再分别接到 live tail 与历史消息，两处同一套截断，避免 live 全量展开、历史另一套高度。
**Spec link:** 无独立 spec；契约来自 logicsync（本会话）+ `specs/146-tui.md` Q5b（摘要行 + diff 增强）。围栏 markdown CodeBlock（`src/tui/markdown.tsx`）不在本计划范围。
**Tracker:** 本地 `plans/` fallback（本会话直接 worktree 实施，不另开 GitHub issue）。
**待写入:** 无（不新增 CONTEXT 词条；UI 形态不上升为领域术语）。
**ACR:** all-yes（见下）。
**Per-ticket loop (all bullets):** tdd → typecheck+相关 tests → one commit on `worktree-tui-write-fold-preview`。整轮结束后由主会话做 code-review + verification-before-completion。

## Affected files (planned)

- `src/tui/tool-summary.ts`（或同模块内并列纯函数；`toolPreviewRows` 调用方收敛）
- `tests/tui/tool-summary.test.ts`（及/或同目录新测）
- `src/tui/live-tool-preview.tsx`
- `tests/tui/live-tool-preview.test.tsx`
- `src/tui/message-blocks.tsx`

## 0. ACR 5-verdict

- bounded-context-guardian: **yes** — 只动 `src/tui/` 展示层；不改 `HarnessStreamEvent`、不读工作区文件做草稿、不把围栏 markdown 与工具完成卡混成一个权威源。
- defensive-contract-validator: **yes** — 纯函数覆盖空 content / 缺 path / 超长正文截断 / 非 write-edit 工具空预览；无并发共享可变状态（展示派生）。异常路径：缺旁路时回退 intent-diff（现有 `toolPreviewRows` 纪律）。
- error-handling-enforcer: **yes** — 不新增吞异常 catch；缺字段 → 空预览或不渲染，与现行 `toolPreviewRows` 空数组语义一致。
- complexity-anti-drift: **yes** — 完成态分类与截断集中在一处派生；live / history 只消费结果，不复制截断公式。
- minimal-change-verifier: **yes** — 单一逻辑：完成态折叠预览；commit 按 tracer bullet 切三刀，不混 running 态 live 代码流、不改 markdown 围栏。

**OVERALL: PASS**

## Settled (inherits)

- 生成中（`status === "running"`）：不渲染 `partialInput` 的 `content`；保持单行 `[运行中] name · path`。
- 折叠无定时：落盘成功那一帧就是截断终态，钉在 transcript，不「先全文再过几秒再折」。
- 新文件（写前无内容 / 旁路 `oldContent` 为空）：完成态预览为代码正文，不是整文件绿 diff。
- 覆盖写 / `edit_file`：完成态预览为 diff。
- 权威完成数据：`post_tool_use` 的 `input` + 旁路 `oldContent`/`newContent`；历史无旁路时沿用现有 intent-diff 回退。

## Tasks (ordered by dependency)

1. **完成态预览派生（分类 + 截断）** — tag: `[implementation]`
   - **Inherits:** 上节 Settled：新文件 → 代码行；覆盖/`edit_file` → diff 行；超出可见窗截断并保留「还有 N 行」信息；非 write/edit → 空。
   - **Surface:** TUI（`src/tui/` tool-summary 一带）
   - **Acceptance:** 纯函数单测可 demo：空 content → 无正文行；`write_file` 且 old 空 → kind 为代码且行来自 content；`write_file` 覆盖或 `edit_file` → kind 为 diff；正文长于可见窗 → 只产出窗内行 + 溢出标记；`bash` 等 → 空。现有 `toolPreviewRows` 行为不被悄悄改掉调用语义（新派生可包一层）。`npx vitest run` 覆盖该测文件全绿。
   - Status: [ ] pending

2. **live 完成态接同一派生** — tag: `[implementation]`
   - **Inherits:** running 仍仅状态行；完成态用 T1 派生，不再对 write/edit 无上限展开全量 DiffView。
   - **Surface:** TUI live-tool-preview
   - **Acceptance:** live 预览测：running + 有 `partialInput` 仍 1 行、正文不出现；`write_file` ok 新文件可见截断代码（或截断后的代码行文本）；覆盖/edit 可见截断 diff；溢出行以标记表示而非全文。与 T1 行数/kind 一致。
   - Status: [ ] pending
   - [blocks: T1]

3. **历史消息完成态接同一派生** — tag: `[implementation]`
   - **Inherits:** 历史与 live 完成态同一截断窗，无第二套高度魔法数分叉。
   - **Surface:** TUI message-blocks（工具预览区）
   - **Acceptance:** 历史 write/edit 预览与 T1 同源：新文件代码截断、编辑 diff 截断；窗高与 live 完成态相同常数来源。既有 MessageBlocks 测不倒退。
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel] with T2 after T1

## Out of scope

- 生成中流式画出 `content`（已否决）。
- 改 `markdown.tsx` 围栏 CodeBlock 触发条件。
- 定时自动再折叠、Ctrl 展开全文（本轮不做交互展开）。
- Web UI 工具卡。
- 读工作区文件作为生成中或历史预览的权威源。
