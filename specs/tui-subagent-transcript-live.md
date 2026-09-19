# Spec: tui-subagent-transcript-live — 活子代理两行落在会话 spawn 卡上

**Status:** ready for plan
**Surface:** `src/tui/subagent-message-lines.ts`、`src/tui/live-tool-preview.tsx`、`src/tui/message-blocks.tsx`、`src/tui/app.tsx`、`src/harness/subagent/manager.ts`（只读投影）

> 输入 = `plans/tui-subagent-transcript-live.md`（ACR 5/5 yes；九句锁句；`docs/CONTEXT.md` 词条 `subagent card live` 已 flush）。
> 取代 = Slice D / SC14 把两行做成 prompt 上方 chrome（`SubagentIdentityStrip`）——本 spec 把位置改判给**会话 transcript 里那张 `spawn_subagent` 卡**。
> **Reopen（`plans/strategy-window-and-subagent-card.md` T1）**：锁句 2 / 完成态表 / SC2 —— completed 后概述留下并加 `✓ Done`，不再把第 2 行换成字面 `done`，也不再保留 `running...`。
> 范围 = 位置搬家 + 完成态 + `toolUseId` 只读 join；不改 SubagentPanel、harness spawn/abort、web、Ctrl+X、activity-block live-signal。
> 落地 = T1 本 spec → T2 投影（含 `listSubagents` 只读 `toolUseId`）→ T3 卡承载两行、拆条 → code-review → verification-before-completion。

## Goal

活着的子代理不再画在输入框正上方，而是画在**会话里派它的那张 `spawn_subagent` 卡**下面：live 第 1 行 `{role} running...`，第 2 行 dim 为该 worker 任务概述（`taskPreview`）；完成后概述留下，其下绿 `✓ Done`，不再写 `running...`。输入框上方的身份条拆除，其 chrome 行账归零。

**用户**：iknow 单用户单项目本机产品；TUI 是主验收面（`npm run dev:tui`）。

**要建什么**：

1. **卡级两行投影**（纯函数）：`subagents × toolUseId → {roleLine, detailLine, done}`；join 不上 → 不画第 2 行。
2. **join 键**：`SubagentInfo.toolUseId`（= 派发那次 `spawn_subagent` 的 tool_use id）经 `listSubagents` 只读透出；与卡侧 `tool_use.id` / `LiveToolRun.id` 同一 id 空间。
3. **两个宿主**：live tail（`liveToolPreviewBox`，spawn 前台阻塞期间）与历史卡（`MessageBlocks`，turn 结束后）共用同一投影。
4. **拆除**：`SubagentIdentityStrip` 及其 prompt 侧行账（`subagentRowBudget` → `chromeReserveRows.subagentRows` 产品路径不再喂值）。

## Locked sentences

九句锁句（继承 `plans/tui-subagent-transcript-live.md`；实施与 review 均以此为准）：

1. 每个活着的 `spawn_subagent` 在**会话 transcript 那张卡**占两行：第 1 行 `{role} running...`（三点），第 2 行 dim 为该 worker 任务概述（`taskPreview`）。
2. 该 worker **completed** 后，任务概述留下，其下绿 `✓ Done`；不得把概述换成字面 `done`；不得再写 `running...`。不挪到输入框边上，不随底栏面板淡出而消失。
3. 输入框**正上方**的身份条（`SubagentIdentityStrip`）拆除；其 chrome 行账归零。
4. 输入框**下方** `SubagentPanel`（`●` / 时长 / 完成淡出 / Ctrl+X 行序）本票不改。
5. **failed** 不走绿 `✓ Done`：沿用该工具卡既有 **failure overlay**。
6. 实时流只挂在对得上 `toolUseId` 的那张 spawn 卡上；投影缺 `toolUseId` 则只画第 1 行、不借用别的 worker 的预览（`// EXIT:`）。
7. `subagent_result` 仍是轮询卡，不套这两行。
8. 不再为「避免 dual render」把 spawn 标题剥成不含 `running...` 的残句；身份以会话卡为准，底栏面板仍是任务列表。
9. Web 状态条、harness spawn/abort、activity-block live-signal，本切片不做。

### 锁句的落地解释（防 review 漂移）

- 锁句 1 的「任务概述」**就是** `SubagentInfo.taskPreview`（manager 已截断 ≤120）以 1Hz 只读轮询刷新，**不是**逐 token 流；本切片不新增流式通道。
- 锁句 2：completed 后概述仍在；其下绿 `✓ Done`（含 ✓）。第 1 行不得再带 `running...`。角色标题若仍在，只作身份、不含 running。
- 锁句 6 的「缺 `toolUseId`」= **子代理侧投影缺关联键**（无关联键的 def / 非 spawn 来源）。此时卡照画第 1 行（角色从该卡自身 input 的 `subagent_type` → `role` → catalog fallback 派生），**不**拿任何别的 worker 的 `taskPreview` 顶替。
- 锁句 5 与 6 的关系：failed 的 worker 不进 join map，卡回到既有 failure overlay（标题 + 单行短错误），不画完成态绿勾。
- **完成态依赖进程内投影**：`✓ Done` 需要 `subagents` 列表里仍有该 worker（进程内）。应用重启后没有 join 源 → 该历史卡回既有单行落定摘要；本切片不引入落盘关联（不写第二套持久化）。
- **`wait:false` 的卡**：spawn 立即返回 `{task_id}`（工具卡已落定），worker 仍在跑 —— 两行照画在卡上（join 只问 worker 状态，不问工具卡是否落定）。这不是漏洞，是本切片的正确形态。
- **未 join 的 live spawn 卡**（无 `toolUseId`：ask / 直调 handler / 测试注入）：第 1 行仍画 `{role} running...`（角色由该卡自身 input 的 `subagent_type` → `role` → catalog fallback 派生），无第 2 行 —— 不借用任何别的 worker 预览。该形态与「join 上但仍是 live」在屏上都以 `{role} running...` 开头，区别只在有没有 dim 流那行。

## Card contract（实施面单一形状）

```ts
export interface SubagentCardLines {
  readonly roleLine: string; // live：`{role} running...`；completed：身份行，不含 `running...`
  readonly detailLine: string; // live 与 completed 均为 taskPreview（按 cols 截断）
  readonly doneLine?: string; // completed → `✓ Done`；live 缺席
  readonly done: boolean; // 完成态着色：true → tuiPalette.add（绿）
}
```

| 卡状态                                  | 画面                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| live（`starting` / `running`，join 上） | 第 1 行 `{role} running...`；第 2 行 dim 概述                                                   |
| completed（join 上）                    | 概述留下；其下绿 `✓ Done`；不得 `running...`                                                    |
| failed（join 上）                       | 不套完成态绿勾 —— 走该卡 failure overlay（锁句 5）                                              |
| spawn 卡（running，join 不上）          | 只画第 1 行；文案 = 既有 `formatToolStatusLine` 的 dotless `{role} running`（不改模板，锁句 6） |
| spawn 卡（ok，join 不上）               | 既有单行标题（`{role}` 落定摘要），本切片不改                                                   |
| 非 spawn（含 `subagent_result`）        | 本切片完全不改（锁句 7）                                                                        |

两宿主共用的「第 1 行」文案来源分两路，**不得各写模板**：

- spawn 卡（`spawn_subagent`）且能投影 → 走 `SubagentCardView`（live：`{role} running...` + 概述；completed：概述 + 绿 `✓ Done`）；
- 其余任何工具卡（含 `subagent_result`）→ 完全走既有 `formatToolStatusLine` 路径，字节与改前一致。

即：两行形态只挂在 `spawn_subagent` 上，`isSubagentTool` 的另一半（轮询卡）保持既有 detail-only 形态。

两个宿主共用上表：live tail（`liveToolPreviewBox` / `liveToolPreviewTextLines`）与历史卡（`MessageBlocks`）都必须走同一投影函数，不得各写一套模板。

## Superseded

| 被取代行为                                                                       | 现行落点                                                               | 取代后                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两行画在输入框正上方（`SubagentIdentityStrip`）                                  | `src/tui/subagent-identity-strip.tsx`、`app.tsx` 挂载                  | 两行画在会话 spawn 卡上；组件删除                                                                                                                                                                                                                                                                                                       |
| strip 行数进 chrome 行账（每 live × 2）                                          | `app.tsx subagentRowBudget` → `chromeReserveRows.subagentRows`         | 产品路径不再喂值（缺省 0）；`chromeReserveRows` 的显式入参保留（单测 / 旧调用兼容），与 `panelRows` 同款约定                                                                                                                                                                                                                            |
| 消息两行投影按 live 列表整体铺开                                                 | `subagent-message-lines.ts projectSubagentMessageLines`                | 改卡级投影（按 `toolUseId` join，逐卡）                                                                                                                                                                                                                                                                                                 |
| 两行预算回归钉「strip 占 input 上方 2 行」                                       | `tests/tui/subagent-two-line-budget.test.tsx`                          | 改钉「子代理不占 prompt 行账；两行长在卡上」                                                                                                                                                                                                                                                                                            |
| SubagentPanel 不计入 chrome 行账（`panelRows` 恒 0，「装不下的行溢到屏幕下方」） | #1044 `app.tsx subagentPanelRowBudget` → `chromeReserveRows.panelRows` | 该假设不成立：底部 chrome 无显式高度、默认 `flexShrink=1`，总高超出时 Yoga 把负空间按比例摊给输入框（live ≥7 必现，与终端高无关）。现行：面板行数（折叠上限 `SUBAGENT_PANEL_MAX_ROWS=5`，超限末行折 `… +N`）入账 —— 输入框正常上移且始终完整显示；焦点环 / clamp 同步改用 `visibleLiveRowCount`（可见 live 行数），折叠后焦点不落隐藏行 |

**不授权**（本切片明确排除）：改 `SubagentPanel` 与 Ctrl+X 行序、改 harness spawn/abort/超时、改 web `SubagentStatusBar`、改 activity-block live-signal、给 `subagent_result` 套两行、恢复 prompt 侧身份条、改 `formatToolStatusLine` 的既有文字模板。

## Input-contract classes

| Surface                                                | empty                                                 | invalid / negative                                                     | overflow                                                                  | concurrent                                                   | exception                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `projectSubagentCardLines(subagents, toolUseId, cols)` | 空数组 / `toolUseId` 缺省或空串 → `null`（不借流）    | 无匹配 / 匹配到 failed → `null`；role 空串 / 纯空白 → catalog fallback | 两行各自按 cols 视觉宽度截断（CJK-safe），永不换行；`cols ≤ 0` → 1 列预算 | 两个 live worker：各卡只取自己 join 的 `taskPreview`，互不串 | 不读 `startedAt` / `endedAt`（非法 ISO 不影响投影）；缺 `taskPreview` → 第 2 行空串占位，行账仍 2 行 |
| `subagentCardLinesMap(subagents, cols)`                | 空数组 → 空 map                                       | 缺 `toolUseId` / failed 的条目整体跳过（不入 map）                     | 同左（逐条按 cols 截断）                                                  | 重复 `toolUseId`：列表序首个胜（确定性）                     | 同上                                                                                                 |
| `listSubagents` 的 `toolUseId` 字段                    | def 无 `toolUseId` → 字段整个省略（Postel，字节稳定） | 空串 → 省略                                                            | N/A                                                                       | N/A                                                          | N/A                                                                                                  |
| `liveToolPreviewTextLines(run, cols, card?)`           | 无 card 且 running → 只 1 行                          | failed run → 不消费 card（走既有失败行）                               | 行内容按 cols 截断                                                        | N/A                                                          | N/A                                                                                                  |
| `MessageBlocks` 历史卡                                 | 无 map → 与改前逐字节一致                             | map 命中 failed → 不套两行                                             | 两行按 innerCols 截断                                                     | N/A                                                          | 缺 `subagentCards` prop（旧调用）→ 与改前一致                                                        |

## Success criteria

- **SC1**: 真实会话里，前台 `spawn_subagent` 执行期间，该卡在 transcript 显示 `{role} running...` + 一行 dim `taskPreview`；输入框上方不再出现任何 `{role} running...` 行。
- **SC2**: 该 worker 完成后，同一张卡仍能看见任务概述，其下绿 `✓ Done`（`fg = tuiPalette.add`），不得再写 `running...`，不得只剩字面 `done`。
- **SC3**: 两个并发 live worker 各占自己的卡，预览不串（A 卡不出现 B 的 `taskPreview`）。
- **SC4**: 缺 `toolUseId` 的子代理条目：卡只画第 1 行，不借用他人预览（`// EXIT:` 在拒绝分支上）。
- **SC5**: `chromeReserveRows` 的产品调用不再为子代理预留 prompt 上方行数；live 子代理存在与否不改变 chrome 预算。
- **SC6**: `SubagentPanel`（底栏 `●` 行 / 时长 / 完成淡出 / Ctrl+X 行序）行为与改前一致，既有面板测试全绿。
- **SC7**: `subagent_result` 卡与 failed spawn 卡不套两行（既有 failure overlay / 轮询卡测试全绿）。

## Inherits / Changes

- **继承**：`isLiveSubagent` 判据（`starting` + `running`，与面板 / Ctrl+X 分派同源）、`resolveIdentityRole` 的 catalog fallback（`SUBAGENT_ROLE_FALLBACK`，永不输出「子代理」字面值）、`clipOneLineVisual` 截断纪律、`tuiPalette` 的 `dim` / `add` token、`SubagentInfo` Postel 纪律（可选字段缺席即省略）。
- **变更**：`SubagentInfo` 增可选只读 `toolUseId`；`subagent-message-lines.ts` 的投影从「live 列表整体铺开」改为「按 `toolUseId` 卡级 join」；`SubagentIdentityStrip` 删除；`subagentRowBudget` 保留签名、恒返回 0（见 Superseded 表：让「不再入账」是显式声明，`chromeReserveRows` 的显式入参保留给单测 / 旧调用）。
- **不改**：`src/shared/tool-line.ts` 的文案模板逻辑（子代理分支的 detail-only 形态仍是「join 不上」时的兜底）、`SubagentPanel` 投影、harness spawn/abort 生命周期。

## Evidence pointers

- 计划：`plans/tui-subagent-transcript-live.md`（位置搬家）；完成态修订：`plans/strategy-window-and-subagent-card.md`。
- 前身：Slice D / SC14（`specs/agent-control-surface.md` 已归档）把两行落成 prompt 上方 chrome。
- 领域词：`docs/CONTEXT.md` 词条 **subagent card live（子代理会话卡实时行）**（已 flush，本切片落地）。
- join 键上游：`SubAgentDefinition.toolUseId`（`src/harness/subagent/role.ts`）← `ToolExecutionContext.toolUseId`（executor `call.id`）← `spawn-subagent-tool` 写入 def。
