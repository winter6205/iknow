# TUI 流式尾部：草稿按文本段切开，与工具按事件顺序交错

## 1. Summary

#612 / #616 把 live 工具拆成「首个 text_delta 之前 / 之后」两桶，草稿仍是整 turn 一份 `draftsMasked`。用户路径 `工具 → 文本 → 工具 → 文本` 下，第二段文本并进同一缓冲、画在后续工具上面，新工具被顶到下面；turn 结束靠历史 MessageBlocks 才恢复顺序。

本任务把该已知近似收掉：`stream-draft` 在工具开始时 seal 当前文本段；工具带 `draftEpoch`（seal 时已完成的段数）；ChatView 按 epoch 交错渲染「工具组 i + 段 i」。

## 2. Affects

- `src/cli/stream-draft.ts`
- `tests/cli/stream-draft.test.ts`
- `src/tui/live-tool-state.ts`
- `src/tui/app.tsx`
- `src/tui/chat-view.tsx`
- `tests/tui/live-tool-state.test.ts`
- `tests/tui/chat-view-scroll.test.tsx`
- `tests/tui/stream-draft-integration.test.tsx`
- `scripts/probe-tui-live-order-gap.tsx`

## 3. 5-line verdict block

bounded-context-guardian: yes — seal API 留在 `src/cli/stream-draft.ts` 共享叶层（CLI 不调用则行为与今日相同）；`draftEpoch` 与交错渲染留在 `src/tui/`；无反向依赖、无新 bounded context。
defensive-contract-validator: yes — 5 类边界均有测试槽：empty（seal 无文本 no-op、liveTailSlots([], []) 空槽）；negative（缺省 epoch 0、epoch 大于 segments.length 时工具落在末段之后而非丢弃）；overflow（连续 seal 多段、超长单段仍按段切开）；concurrent（同一 onStream 闭包内 tool→text→tool→text 无 await 连发；sealText 后立刻 append，maskedSegments() 同步可读、不依赖 50ms notify / useDeferredValue）；exception（reset 后 seal 不抛；liveTailSlots 对空段/缺字段不抛，跳过空 draft 槽）。ChatView 单段兼容旧两桶场景 + 两段交错帧序。
error-handling-enforcer: yes — 无新失败路径；seal/交错为纯状态变换；既有 stream-draft listener 隔离与 liveToolReduce unmatched ignore 不变。
complexity-anti-drift: yes — ChatView 用 `liveTailSlots(runs, segments)` 纯函数产出交错槽，JSX 只 map 槽；onStream 在 tool_call_start 调 `sealText()` 后写入 epoch，不在 updater 内重读。
minimal-change-verifier: yes — 1 逻辑任务（live 顺序对齐历史终态的多段交错）；不改 CLI 写出、不改折叠、不改 #589 只读移除。

## 4. 行为合同

1. 事件 `tool* → text1 → tool* → text2` 的 running 帧序 = 早工具 < text1 < 晚工具 < text2（与历史 content 块顺序一致，结束不再跳变）。
2. 仅 `tool* → text` 或 `text → tool*` 的既有两桶行为保持。
3. `createStreamDraft().masked()` 仍为全量拼接（CLI 不变）；TUI 消费 `maskedSegments()`。
4. `sealText()`：当前 raw 为空则 no-op；非空则冻结为一段并清空当前缓冲。
5. `draftEpoch` 缺省 0（先于任何已 seal 段）；`afterDraft` 布尔删除，由 epoch 取代。
6. 时序：`tool_call_start` 先 `sealText()` 再在 updater 外读取 `sealedCount` 打入 epoch（沿用 #616：禁止在 setState updater 内重读）。ChatView 对 `draftSegments` 仍走 `useDeferredValue`；epoch 在 tool 条目上，与草稿延迟解耦——延迟帧只晚画新文本，不把已 stamp 的工具顶到新文本下。
7. `liveTailSlots(runs, segments)`：按 epoch 0..max 交错输出 `{kind:'tools'} | {kind:'draft'}`；空 draft 跳过；epoch ≥ segments.length 的工具挂在末尾。
