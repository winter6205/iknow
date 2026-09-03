# Plan: TUI 显示一致性

**Goal:** 流式与历史外观零跳变、思考时长随消息落盘、折叠作用于每一轮、工具结果以 5 行预览上屏、TUI/web 消费同一份数据。

**Approach:** 六条 tracer bullet 按依赖排序：先统一壳与文案（T1）并铺落盘轨道（T2，两者平行）；然后折叠简化（T3，消费 T1 的壳与 T2 的数据）、结果预览（T4，消费 T1 的注册表）；web 端（T5）最后接入；清理（T6）随时可做。每条 bullet 一 commit，垂直贯穿它涉及的每一层（schema / harness / TUI / web / tests）并端到端可演示。

**Spec link:** `specs/tui-display-consistency.md`
**ACR:** all-yes（复审 5/5，见下方 verdict block）
**Tracker:** 本地 markdown fallback——`gh` CLI 对 api.github.com 不可达（实测 i/o timeout），不建 GitHub issues；bullet 状态以本文件 Status 复选框为准。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

```
bounded-context-guardian: yes — D1/D4/D7 落点收敛在 src/tui/（display 域），D2 仅在既有 schema 上 additive 增字段，D6 落 web 但消费同一份落盘数据；无跨域反向依赖。
defensive-contract-validator: yes — D2 钉死 thinkingMs<=0/非有限数→字段缺席、并行不齐→null 兜底；D4 钉死空/全空白/ANSI strip 后为空→不渲染预览块、截断不切断转义序列；D7 钉死 MessageBlocks memo 不外移 + history-rerender-cost 闸为硬约束。
error-handling-enforcer: yes — D2 测量无效走 Postel 字段缺席；D4 输出边界走视觉降级而非抛错；D5 纯删除无新错误路径。
complexity-anti-drift: yes — D7 注册表合并 + memo 维持钉住；D5 删除孤儿减面；D2 照抄 messageCreatedAt 模式而非新发明。
minimal-change-verifier: yes — D1-D7 各自独立 logical task；SC1-SC9 每条钉住具体 rg / bun test 命令；删除目标与新增落点一一对应。
```

## 待写入

（空——`result preview`、`thinking duration` 两领域词已于 spec 阶段 persist 进 `docs/CONTEXT.md`；无 ADR 冲突。）

## Tasks (ordered by dependency)

1. **外壳统一：共用 assistant 壳 + 工具状态行文案 SSOT** — tag: `[implementation]`
   - **Inherits:** spec D1/D7——「把 `MessageBlocks` 的 assistant 外壳（assistantBg + paddingX + marginTop）抽为共用组件，三个消费方统一套壳：MessageBlocks assistant 分支、chat-view live 草稿槽、折叠行渲染」；「工具状态行 `[运行中]/[完成]/[失败] name · detail` 拼装收敛为单一纯函数，live 与历史两侧都调用；子代理独立形态（▣/✓/✗ 子代理 · detail）保留为该纯函数内分支」；「外壳组件独立 memo 包裹，MessageBlocks 现有 memo 不外移不被抽壳破坏，history-rerender-cost 闸维持通过是硬约束」。
   - **Surface:** `src/tui`（message-blocks / chat-view / live-tool-preview / tool-summary 或 live-tool-state——纯函数落点 PLAN 期留白，两处各收敛一次）。
   - **Acceptance:** testRender 渲染同一段内容的 running 态与 idle 态，两帧中正文起始列相同、工具状态行字面量相同（spec SC1）；`tests/tui/history-rerender-cost.test.tsx` 闸通过。
   - Status: [ ] pending
   - [blocks: T3, T4]

2. **thinkingMs 落盘轨道（adapter 测量 → commit → stamp → projection）** — tag: `[implementation]`
   - **Inherits:** spec D2——「测量点在 adapter 流式路径（首条 thinking_delta 至首个非思考增量），thinkingMs?: number 挂 AssistantTurnResult（与 usage 同一 Postel 纪律）」；「完全照抄 messageCreatedAt 模式：SessionEventRecord.thinkingMs?: number（缺席不 fail validation）；SessionFileV1.thinkingMs?: ReadonlyArray<number | null>（additive，schema 版本不升）；projectSessionLog 按 hasAny 条件发 key；sessionFileToJsonl round-trip」；「thinkingMs <= 0 或非有限数 → 字段缺席；并行数组长度不齐 → null 兜底，消费侧 ?? undefined 同语义」。
   - **Surface:** `harness`（anthropic-adapter / loop-engine / types）+ `session-api`（store schema / jsonl / session-store / hub）。
   - **Acceptance:** 多 turn stub 会话跑完后 JSONL 事件链上 assistant 事件携带 thinkingMs，projectSessionLog 重建出与 messages 对齐的并行数组，无思考/非流式场景字段整体缺席（spec SC2）；round-trip 测试通过。
   - Status: [ ] pending
   - [parallel]（与 T1 无共享文件，可并行）

3. **折叠简化：全轮生效 + 删 TUI 内存副通道** — tag: `[implementation]`
   - **Inherits:** spec D3——「删除 inLastTurn 门；删除 shouldShowTurnActivityFold 的 thinkingSeconds > 0 || turnToolTotal > 1 闸门，任何已完成工具轮次都折叠；running 态保持逐条可见（现行测试钉住的行为不变）」；「折叠输入改用 D2 落盘数据（纯函数：簇 messageIndex 范围 + 并行数组 → 求和）」；「删除整条内存副通道：lastThinkingSeconds / thinkingFrozenSeconds / thinkingFrozenRef / pinAndStoreThinkingSeconds / pinThinkingSeconds / thinkingPlaced / ChatViewProps 两 prop」；「流式期间『思考中…』临时指示保留；旧会话无 thinkingMs 时折叠行只显示工具计数」。
   - **Surface:** `src/tui`（chat-view / turn-activity / app / stream-draft / think-fold）。
   - **Acceptance:** `rg -n "lastThinkingSeconds|thinkingFrozenSeconds|pinThinkingSeconds|thinkingPlaced" src/` 零命中（spec SC3）；两轮会话渲染各自出现折叠行且旧轮 `[完成]` 行不回摊、单工具无秒数轮次也折叠、running 态逐条可见（spec SC4）；`tests/tui/chat-view-thinking-tool-fold.test.tsx` / `turn-activity.test.ts` 按新语义重写后全绿。
   - Status: [ ] pending
   - [blocks: T1, T2]

4. **结果预览：5 行 dim 输出块 + 注册表一体声明** — tag: `[implementation]`
   - **Inherits:** spec D4/D7——「标题行下方 ⎿ 风格 dim 前缀结果块，上限 5 行；bash 显示 stdout/stderr 尾部 5 行，超出首行 `… +N 行`；失败内容照显标红；子进程 ANSI 透传不重新染色」；「ToolResultMeta 扩 stdout/stderr 承载字段（显示层投影，不经 encodeToolResults 进模型 tool_result）」；「空/全空白/ANSI strip 后为空 → 不渲染预览块；单行直接显示；ANSI 按剥离后宽度计数、截断不切断转义序列」；「read_file 不显示预览；write/edit 维持 6 行不变；skill 显示一行结果；无输出工具一行摘要或省略；live 与历史同规则」；「工具状态行文案纯函数与结果预览函数同置一处，新增一种工具的显示只需在一个注册表加声明；EXPECTED_TOOLSET_* 闸沿用」。
   - **Surface:** `src/tui`（tool-summary 注册表 / message-blocks / live-tool-preview / completed-tool-preview-view）+ `harness`（tools types 的 ToolResultMeta）。
   - **Acceptance:** stub bash 返回多行输出时标题行下方渲染尾部 5 行 dim 预览、超出带 `… +N 行`，失败标红，read_file 无预览块（spec SC5）；`tests/tui/deps-tools.test.ts` EXPECTED_TOOLSET_* 闸通过且新声明点唯一（spec SC6）。
   - Status: [ ] pending
   - [blocks: T1]（与 T2/T3 平行可交错，但共享 message-blocks 时先到者先合）

5. **web 端消费：thinking 秒数 + 结果预览同规则** — tag: `[implementation]`
   - **Inherits:** spec D6——「AgentCard 消费同一份落盘数据：thinking 折叠块带真实秒数；toolCalls 活动流接入结果预览同规则（5 行截断、失败标红）；web 侧具体视觉 PLAN 细化，spec 钉住数据源与规则一致性」；「旧会话无秒数：折叠块只显示工具计数」。
   - **Surface:** `web`（AgentCard 及其 thinking/toolCalls 子组件）。
   - **Acceptance:** web 测试套件断言 thinking 块显示落盘秒数、toolCalls 按 5 行截断 + 失败标红（spec SC8），用例与 TUI 侧同构。
   - Status: [ ] pending
   - [blocks: T2, T4]

6. **清理：孤儿模块与过时注释** — tag: `[implementation]`
   - **Inherits:** spec D5——「删除 src/tui/scrollable-output-region.tsx 及其单测（唯一引用者是自己）；修正 chat-view.tsx 顶部过时注释（称历史 preview 走 ScrollableOutputRegion，实际已是 CompletedToolPreviewView）」。
   - **Surface:** `src/tui`。
   - **Acceptance:** `rg -n "scrollable-output-region" src/ tests/` 零命中（spec SC7）；全量 `npm test` 绿（spec SC9 回归闸）。
   - Status: [ ] pending
   - [parallel]（不与任何 bullet 共享行为面，随时可做；建议最后跑，连同 SC9 一次收口）

## 收尾

全部 bullet 落地后跑一轮 code review（整轮改动收尾，非每 bullet 重复），确认 SC1–SC9 逐条可打勾，`npm test` 全绿。
