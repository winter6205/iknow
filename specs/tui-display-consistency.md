# Spec: TUI 显示一致性（外壳统一 / 思考时长落盘 / 折叠简化 / 结果预览 / 清理）

## Objective

TUI 的会话流里，工具调用与其结果的可见性由四条相互独立、各自补丁式的规则决定，导致四类用户可见的不一致：

1. **外壳跳变**：流式草稿没有 assistant 底色外壳，turn 结束时历史渲染接管，同一内容右移一列并突然套上深色底；工具状态行文案两条路径各写一份（live `bash · pwd · ok` vs 历史 `[完成] bash · pwd`）；折叠行裸挂也在壳外，左移一列。
2. **思考时长是 UI 副产物**：「思考了 N 秒」由 TUI 用墙上时钟在流式过程中量出、存内存——只活当前轮、重启即失、历史轮次拿不到、跨会话串味（源码注释自认未做归属校验）。web 端永远拿不到。
3. **折叠作用域残缺**：折叠只对最后一轮生效（`inLastTurn` 门），发新消息旧轮回摊；单工具且无思考秒数的轮次永不折叠。
4. **工具结果不上屏**：bash 的 stdout/stderr、skill 的加载结果等 tool_result 内容只进模型上下文，用户看不到——只有 write/edit 有 6 行代码/diff 预览。

本 spec 给出一次性收敛：流式与历史共用一套外观壳与文案；思考时长成为 assistant 消息的落盘属性；折叠作用于每一轮历史；工具结果以截断预览的形式上屏；顺带清理孤儿模块。使用者为 TUI 与 web 端的最终用户。

## Boundaries

- **Does:**
  - **D1 外壳统一**：把 `MessageBlocks` 的 assistant 外壳（`assistantBg` 底色 + `paddingX` + `marginTop`）抽为共用组件，三个消费方统一套壳：`MessageBlocks` assistant 分支、`chat-view.tsx` live 草稿槽、折叠行渲染。工具状态行 `[运行中]/[完成]/[失败] name · detail` 的拼装收敛为单一纯函数（落点在 `tool-summary.ts` 或 `live-tool-state.ts`，PLAN 定），live 与历史两侧都调用；子代理独立形态（`▣/✓/✗ 子代理 · detail`）保留为该纯函数内的分支。
  - **D2 思考时长落盘**：测量点在 adapter 流式路径（`anthropic-adapter.ts`，首条 `thinking_delta` 至首个非思考增量的时长），产出 `thinkingMs?: number` 挂在 `AssistantTurnResult` 上（与 `usage` 同一套 Postel 纪律：测不到则字段缺席）。穿过 `loop-engine.ts` 的 `commitMessagesOrThrow` → `LoopEngineDeps.commitMessages` 钩子（`loop-engine.ts:289`，3 个调用点）→ hub 两处实现 → `store.appendEvents` stamp → `projectSessionLog` 重建并行数组。落盘形态**完全照抄 `messageCreatedAt` 模式**：`SessionEventRecord.thinkingMs?: number`（optional，缺席不 fail validation）；`SessionFileV1.thinkingMs?: ReadonlyArray<number | null>`（additive，schema 版本不升）；`projectSessionLog` 按 `createdAtList` 同样的 hasAny 条件发 key；`sessionFileToJsonl` round-trip。因为并行数组从事件链结构性重建，压缩 / rewind / fork 后对齐是结构性保证。边界形态钉死：`thinkingMs <= 0` 或非有限数 → 测量无效，字段缺席（不落 0 也不落负值）；并行数组与 messages 长度不齐 → validate 拒绝该文件（与 `messageCreatedAt` 同一校验 posture，若现无该校验则不加——缺齐以 `null` 兜底，消费侧 `?? undefined` 同语义）；TUI 求和纯函数对 `null`/缺席元素按 0 计入。
  - **D3 折叠简化**：删除 `inLastTurn` 门；删除 `shouldShowTurnActivityFold` 的 `thinkingSeconds > 0 || turnToolTotal > 1` 闸门，改为任何已完成工具轮次都折叠；running 态保持逐条可见（现行测试钉住的行为不变）。折叠输入改用 D2 的落盘数据（纯函数：簇 messageIndex 范围 + 并行数组 → 求和）。TUI 侧删除整条内存副通道：`app.tsx` 的 `lastThinkingSeconds` / `thinkingFrozenSeconds` / `thinkingFrozenRef` / `pinAndStoreThinkingSeconds`、`stream-draft` 的 `pinThinkingSeconds`、`chat-view.tsx` 的 `thinkingPlaced`、`ChatViewProps` 上的两个思考秒数 prop。流式期间「思考中…」临时指示保留。旧会话无 `thinkingMs`：折叠行只显示工具计数，不显示秒数。
  - **D4 结果预览**：工具调用标题行下方新增结果预览块——`⎿` 风格 dim 前缀；**上限 5 行**；bash 显示 stdout/stderr **尾部** 5 行（测试摘要、git 结果通常在末尾），超出在首行显示 `… +N 行`；失败时内容照常显示但整体标红；bash 等子进程输出的 ANSI 颜色**透传**（git/npm 自带颜色原样可见），不重新染色。数据来源：handler 返回的 `{ output, meta? }` envelope——`meta` 走观测旁路（`plain-string tool output` 契约 Y1/#298：永不进模型视野），TUI 从旁路取数，模型视野不变。`ToolResultMeta` 扩展一个 bash 输出承载字段（如 `stdout?: string` / `stderr?: string`，PLAN 定具体形态）；该字段是显示层投影，不经 encodeToolResults 进模型 tool_result。边界形态钉死：输出为空 / 全空白 / ANSI strip 后为空 → 不渲染预览块（不是渲染空块）；单行输出直接显示 1 行；ANSI 序列在视觉宽度收口（`visualWidth`）时按已剥离宽度计数，截断不得切断转义序列中间。`read_file` **不显示**内容预览（模型要用、用户未必想看，且与 write/edit 预览重复）；write/edit 维持现有 6 行预览不变；skill 类显示一行结果（如加载成功文案）；无输出工具显示一行摘要或省略。本轮不做展开/折叠交互（ctrl+o 类），截断即最终形态。live 与历史两条路径同规则。
  - **D5 清理**：删除孤儿模块 `src/tui/scrollable-output-region.tsx` 及其单测（唯一引用者是自己）；修正 `chat-view.tsx:44` 过时注释（称历史 preview 走 `ScrollableOutputRegion`，实际已是 `CompletedToolPreviewView`）。
  - **D6 web 端**：`web/src/components/AgentCard.tsx` 消费同一份落盘数据——thinking 折叠块带上真实秒数；toolCalls 活动流接入结果预览同规则（5 行截断、失败标红）。web 侧的具体视觉方案在 PLAN 阶段细化，本 spec 钉住数据源与规则一致性。
  - **D7 模块整理**：D1 抽出的共用 assistant 外壳组件落点在 `src/tui/`（如 `components.tsx` 或独立文件，PLAN 定）；**memo 边界必须保持**：外壳组件独立 `memo` 包裹，`MessageBlocks` 现有 `memo`（`message-blocks.tsx:187`）不外移、不被抽壳破坏——`tests/tui/history-rerender-cost.test.tsx` 闸维持通过是 D1 的硬约束。工具状态行文案纯函数与 D4 的结果预览函数**同置一处**，让「新增一种工具的显示」只需要在一个注册表里加声明（摘要 + 结果预览一体声明），而不是散改三处。注册表测试完备性沿用 `EXPECTED_TOOLSET_*` 闸（`tests/tui/deps-tools.test.ts`），新注册表结构必须有对应用例。

- **Confirms with human:** (none — assumption gate 已清)

- **Out of this spec:**
  - 展开/折叠交互（ctrl+o 类）与任何按键系统改动。
  - read_file 内容预览。
  - 模型上下文内容、tool_result 编码格式、replay 语义（`meta` 旁路不触碰 model-facing 内容）。
  - 旧会话回填思考时长（明确不做；旧数据折叠行不带秒数）。
  - 旧会话兼容性兜底（明确不考虑旧会话兼容）。

## Success Criteria

- **SC1（D1 外壳零跳变）**：`testRender` 渲染同一段内容的 running 态与 idle 态，断言两帧中正文起始列相同、工具状态行字面量相同。命令：`bun test tests/tui/`（含新增 parity 用例）。
- **SC2（D2 落盘）**：多 turn stub 会话跑完后，会话 JSONL 事件链上每条 assistant 事件携带 `thinkingMs`；`projectSessionLog` 重建出与 messages 对齐的并行数组；无思考/非流式场景字段整体缺席。命令：`bun test tests/session-api/`（含新增 round-trip + projection 用例）。
- **SC3（D2+D3 删除净额）**：`rg -n "lastThinkingSeconds|thinkingFrozenSeconds|pinThinkingSeconds|thinkingPlaced" src/` 零命中。
- **SC4（D3 折叠全轮生效）**：渲染两轮会话（各含工具调用与思考），断言两轮各自出现折叠行且旧轮 `[完成]` 行不回摊；单工具、无秒数轮次也折叠；running 态逐条可见。命令：`bun test tests/tui/chat-view-thinking-tool-fold.test.tsx tests/tui/turn-activity.test.ts`。
- **SC5（D4 结果预览上屏）**：stub bash 工具返回多行输出时，标题行下方渲染尾部 5 行 dim 预览，超出带 `… +N 行`；失败场景内容照显且标红；`read_file` 无预览块。命令：`bun test tests/tui/message-blocks.test.tsx tests/tui/tool-summary.test.ts`。
- **SC6（D7 注册表）**：`tests/tui/deps-tools.test.ts` 的 `EXPECTED_TOOLSET_*` 闸通过，且新注册表结构下新增工具的声明点唯一（审计：`rg "summarizeToolCall|completedToolPreview" src/tui/` 命中的调用面收敛到注册表单点）。
- **SC7（D5 清理）**：`rg -n "scrollable-output-region" src/ tests/` 仅剩 0 命中（文件与单测已删）。
- **SC8（D6 web 一致）**：web 端 AgentCard 的 thinking 块显示落盘秒数、toolCalls 活动流按同规则截断（用例与 TUI 侧同构）。命令：web 测试套件（`web/` 内既有 runner）。
- **SC9（回归闸）**：`npm test` 全绿（husky pre-commit 同闸）。

## Open Questions

(none — 假设清单 1-15 已经人工逐条确认/修正，无遗留。)

## Inherits / Changes

**Inherits（本仓既有，spec 依赖）：**

- 渲染架构 SSOT：`src/tui/tool-summary.ts`（`SUMMARIZERS` per-tool lookup、`clipOneLine`/`visualWidth` 视觉宽度收口、`completedToolPreview` 写/改预览、`toolResultStatusMap`）、`live-tool-state.ts`（reducer 状态机）、`message-blocks.tsx`（历史渲染）、`live-tool-preview.tsx`（live tail）、`completed-tool-preview-view.tsx`（live+历史共用预览 JSX）、`diff-view.tsx`、`theme.ts`（`tuiPalette` 色板）。
- 落盘轨道：`messageCreatedAt` 并行数组模式（`src/session-api/store/schema.ts:163`、`jsonl.ts` spread-discipline + hasAny 条件发 key、`session-store.ts:253` appendEvents stamp）——D2 照抄此模式。
- commit 缝：`LoopEngineDeps.commitMessages`（`loop-engine.ts:289`，3 调用点）→ hub 两处闭包（`hub.ts:1435/2091`）→ `appendSessionEvents` → `store.appendEvents`。
- 数据契约：`plain-string tool output`（Y1/#298）handler envelope `{ output, meta? }` 观测旁路——D4 数据来源；`executor truncation authority`（契约 X）executor 是截断元数据唯一权威——D4 显示层截断不改变 executor 对模型视野的截断职责。
- 既有领域词（CONTEXT.md）：`fence display cap`（围栏 32 行 ≠ 工具预览 6 行，本 spec 新增 5 行结果预览与之三分，各管一类）。
- 测试基建：bun:test（TUI 子套件）、`testRender` + `captureCharFrame`、`EXPECTED_TOOLSET_*` 工具集闸、`NoopTraceService` deepEqual 基线纪律。
- web 侧：`web/src/components/AgentCard.tsx`（thinking 折叠块 + toolCalls 活动流，wire 已携带数据）。

**Changes（本 spec 引入）：**

- 新增：共用 assistant 外壳组件；工具状态行文案 SSOT 纯函数；`thinkingMs` 测量与落盘轨道（schema additive，版本不升）；结果预览声明（并入工具显示注册表）；web 端秒数与结果预览消费。
- 删除：`inLastTurn` 折叠门；`shouldShowTurnActivityFold` 秒数/计数闸门；TUI 内存思考秒数副通道全链；`scrollable-output-region.tsx` 及其单测；`chat-view.tsx:44` 过时注释。

**待写入 CONTEXT.md 清单（persist list）：**

- 新词「结果预览」（tool result preview）：工具调用标题行下方的截断输出块——数据走观测旁路（meta），规则与 `fence display cap`、write/edit 6 行预览并列第三类显示窗。
- 新词「思考时长」（thinking duration）：assistant 消息的落盘属性（`thinkingMs` 并行数组），非 UI 测量值；折叠簇时长 = 簇内消息求和。
