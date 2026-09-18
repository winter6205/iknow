# Plan: TUI subagent transcript live

**Goal:** 活子代理的两行（`{role} running...` + dim 最新流；完成后第二行原位绿 `done`）画在会话消息里那张 `spawn_subagent` 卡下，并拆掉输入框上方的身份条。
**Approach:** 先把位置合同写入 spec。投影仍是纯函数，用 `toolUseId` 对上工具卡。transcript 接上的同一切片里卸掉 prompt 上方 strip，避免双画。输入框下方 `SubagentPanel`（完成即淡出）本票不动。
**Spec link:** `specs/tui-subagent-transcript-live.md`（T1 产出；落地前本计划 Locked sentences 为 Inherits 源）
**Predecessor:** Slice D / SC14 把两行做成 prompt 上方 chrome（`SubagentIdentityStrip`）；本计划 supersede 该位置，不重开 Ctrl+X / 底栏焦点环。
**ACR:** all-yes（block below）
**待写入:** 已 flush：`subagent card live`。无新 ADR。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

bounded-context-guardian: yes — stay in TUI hosts + `src/shared/tool-line.ts` peel and optional read-only `toolUseId` on existing `SubagentInfo`; no spawn/abort rewrite, web bar, or panel rewrite.
input-contract-tests: yes — empty / negative / overflow / concurrent / exception aligned with current two-line projection tests, plus message-blocks / tool-summary / chrome budget.
error-handling-enforcer: yes — no new lifecycle throws; missing role → catalog fallback; illegal ISO ignored; missing `toolUseId` does not attach another card's stream (`// EXIT:`).
complexity-anti-drift: yes — keep one pure projection; strip JSX may unmount; transcript consumes it; no god renderer.
minimal-change-verifier: yes — one display move (prompt-adjacent two-line chrome → spawn card); locked out: SubagentPanel, harness spawn/abort, web SubagentStatusBar, Ctrl+X, activity-block live-signal.

Affected files (review enumerate, not implementer freeze): `specs/tui-subagent-transcript-live.md`, `docs/CONTEXT.md`, `src/tui/app.tsx`, `src/tui/subagent-identity-strip.tsx`, `src/tui/subagent-message-lines.ts`, `src/tui/message-blocks.tsx`, `src/tui/transcript-tail.tsx` / `src/tui/chat-view.tsx` as needed, `src/tui/live-tool-state.ts`, `src/shared/tool-line.ts`, `src/harness/subagent/manager.ts` (list projection only), `tests/tui/subagent-*.tsx`, `tests/tui/message-blocks.test.tsx`, `tests/tui/tool-summary.test.ts`, `tests/tui/subagent-two-line-budget.test.tsx`.

## Locked sentences

1. 每个活着的 `spawn_subagent` 在**会话 transcript 那张卡**占两行：第 1 行 `{role} running...`（三点），第 2 行 dim 为该 worker 最新内容（`taskPreview`）。
2. 该 worker **completed** 后，第 2 行**原位**变成绿色 `done`，不挪到输入框边上，不随底栏面板淡出而消失。
3. 输入框**正上方**的身份条（`SubagentIdentityStrip`）拆除；其 chrome 行账归零。
4. 输入框**下方** `SubagentPanel`（`●` / 时长 / 完成淡出 / Ctrl+X 行序）本票不改。
5. **failed** 不走绿 `done`：沿用该工具卡既有 **failure overlay**。
6. 实时流只挂在对得上 `toolUseId` 的那张 spawn 卡上；投影缺 `toolUseId` 则只画第 1 行、不借用别的 worker 的预览（`// EXIT:`）。
7. `subagent_result` 仍是轮询卡，不套这两行。
8. 不再为「避免 dual render」把 spawn 标题剥成不含 `running...` 的残句；身份以会话卡为准，底栏面板仍是任务列表。
9. Web 状态条、harness spawn/abort、activity-block live-signal，本切片不做。

## Tasks (ordered by dependency)

1. **Record the transcript-live contract in spec** — tag: `[decision]`
   - **Inherits:** Locked sentences 1–9；operator：底栏面板先不动
   - **Surface:** `specs/tui-subagent-transcript-live.md`；若仓库仍用活跃 spec 索引则只登记这一条
   - **Acceptance:** spec 引用九句锁句；写明 superseded：prompt 上方两行身份条 = 会话消息内两行；不授权改 SubagentPanel、Ctrl+X、web
   - Status: [x] done（`specs/tui-subagent-transcript-live.md`；仓库已无活跃 spec 索引 → 只落文件）

2. **Project two lines including done; join by toolUseId** — tag: `[implementation]`
   - **Inherits:** T1 sentences 1–2, 5–6
   - **Surface:** TUI 纯投影 + 既有 `listSubagents` 只读面（可加可选 `toolUseId`）
   - **Acceptance:** live → `{role} running...` + dim preview；completed → 第二行 `done`；缺 role → catalog fallback；空 preview 仍占两行账；cols 单行截断；两个 live 互不串预览；缺 `toolUseId` 不把 A 的流画到 B；非法 ISO 不影响投影。`npm test` 覆盖该派生的用例绿
   - Status: [x] done（`subagent-message-lines.ts` 卡级投影 + `SubagentInfo.toolUseId` 只读透出；`tests/tui/subagent-card-lines.test.ts` 投影 SSOT 测、`tests/subagent/manager.test.ts` +3 例。review 修复：签名改 JSON 编码（单射 + 去字面控制字节），`RUNNING_SUFFIX` 收回模块私有）
   - [blocks: T1]

3. **Spawn cards own the two lines; prompt strip gone** — tag: `[implementation]`
   - **Inherits:** T1 sentences 1–4, 7–8
   - **Surface:** TUI chat transcript + prompt chrome
   - **Acceptance:** 会话里每张活 spawn 卡可见 `running...` 与其下 dim 流；完成后该卡第二行绿 `done`；输入框上方不再出现 `{role} running...`；`chromeReserveRows` 的子代理条行数为 0；既有两行预算测改为「strip 不占 prompt 行账」而非允许叠字。底栏 `●` 行行为与改前一致
   - Status: [x] done（两宿主同渲染面：`live-tool-preview.tsx` + `message-blocks.tsx` 走 `subagent-card-view.tsx`；`SubagentIdentityStrip` 与 `subagentRowBudget` 行数拆除；`tests/tui/subagent-two-line-budget.test.tsx` 重写为 9 例。review 修复：failure 横切收敛为 `cardIfLive` 单函数；新增历史宿主接线测 `tests/tui/subagent-card-history-host.test.tsx` 7 例；被拆的 strip 测以 ARCHIVED 头归档进 `archive/tests/tui/`）
   - [blocks: T2]

## Code review phase

整轮落地后 `code-review`；`GATE: BLOCKED` → `review-report-repair`。

- Standards axis：2 High / 4 Medium / 3 Low —— 全部按 `review-report-repair` 处置（8 修 1 保留并说明；见 handoff）。
- Spec axis：见 Review 小节。
