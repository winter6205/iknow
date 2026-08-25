# Plan: TUI 流式第二阶段 — 思考展开 + 工具实时展示 + 用户消息即时回显 + 渲染节流

> 来源：用户指令（流式的下一步）+ `plans/streaming-rendering.md`（第一阶段 #214 已落地）
>
> - `.claude/worktrees/tui-bench-research/.reference/tui-benchmark.html` 调研结论。
>   调研依据：三路 explorer（TUI 现状 / harness 协议 / 同类开源实现模式）。

## 0. ACR 5-verdict（pre-implementation gate）

- bounded-context-guardian: **yes** — `HarnessStreamEvent` SSOT 留在 `src/harness/stream.ts`；adapter `wireStreamEvents` 仍是唯一 emit 点；`src/cli/stream-draft.ts` 共享叶层无反向依赖；TUI 仅消费（callback-into-poster）。模块边界未破。
- defensive-contract-validator: **yes** — 5 类边界均覆盖：空 thinking_delta 抑制（对齐 `anthropic-adapter.ts:539` text_delta 既有纪律）、extended-thinking 未开启时无 delta（no-op）、tool_call_start 缺 id 向后兼容（fallback 字符串行）、abort 路径 streamDraft.reset 取消 pending 批处理（timer 清理 + unref）、并发同名工具按 FIFO 配对。T2 输入空字符串防 echo、T5 reset 取消 timer。
- error-handling-enforcer: **yes** — 新事件经 `safeEmit` 路径（`anthropic-adapter.ts:527` 既有 try/catch 吞 D3 纪律）；stream-draft append 失败回退既有；liveToolCalls 配对缺 id 时 typed fallback 而非裸 undefined；无 magic error code。
- complexity-anti-drift: **yes** — T1 stream.ts 加 1 variant + wireStreamEvents 加 content_block_delta 分支（+5 行）；T2 session-state 加 reducer（≤10 行纯函数）；T3 stream-draft 加 thinking buffer（+15 行，单函数 ≤30）；T4 liveToolCards 状态机 + 配对 helper（≤20 行）；T5 stream-draft 节流批处理（+20 行）。函数 ≤40 / 文件 ≤500 / 嵌套 ≤4 / 参数 ≤4 全在阈值内。React.startTransition + useDeferredValue 是 React 19 自带，无新依赖。
- minimal-change-verifier: **yes** — 5 commits 对应 5 tracer bullets，零 scope creep，无 refactor-as-feature 混入，无新顶层依赖。无既有测试删除/降级。

**OVERALL: PASS** — 实施可启动。

## 1. Destination

第一阶段（#214）已贯通：text_delta 流式草稿 + 密钥遮蔽 + thinking 终稿折叠面板。
本阶段补齐「对话进行时」的可见性四件套：

1. **用户消息即时回显**：提交的提示词立刻出现在对话里，不等 turn 结束。
2. **thinking 流式展开**：思考内容在流式期间可见（默认折叠单行摘要，`/thinking` 展开看流式内容）。
3. **工具调用实时展示**：`tool_call_start` → 立即出现「运行中」行；postToolUse 完成 → 配对为 ok/failed 摘要行。**不展示 harness 内部 query**（system prompt / 工具描述 / 注入段永不上 UI，现状已满足，补守卫测试）。
4. **渲染节流**：50ms / 384 字符批处理（生产端）+ startTransition / useDeferredValue（消费端防御），消除每 delta 全树重渲染。

**模型上下文回传机制**：用户消息即时回显的可见层 = 进入模型上下文的消息
（`encodeUserText` verbatim，无 harness 注入混入 UI）；会话续传（priorMessages）
既有不变。守卫测试锁定「UI 可见用户消息 == 模型上下文用户消息 == 用户所打字面」。

## 2. 现状事实（explorer 结论摘要）

- `HarnessStreamEvent` 仅 `text_delta` + `tool_call_start{name}`（`src/harness/stream.ts:17-19`）；
  thinking_delta / input_json_delta 为 D1 刻意延迟项，本阶段扩展 thinking_delta + tool_call_start 加 id。
- `tool_call_start` 目前被 `stream-draft.append` 忽略（`src/cli/stream-draft.ts:51-56`）；
  live 工具行来自 postToolUse 钩子（事后，`src/tui/deps.ts:86-100`）。
- 用户消息在 `turnStarted` 不进 `session.messages`（`src/tui/app.tsx:256-300`），
  turn 结束重读文件才出现 —— 最大 UX 缺口。
- 渲染零节流：每 text_delta 同步 `setDraftsMasked` → 全 ChatView 重渲染 + 全量 markdown 重解析。
- 无 harness 内部 query 泄漏（`encodeUserText` verbatim + system 注入走独立 resolver，不上 UI）。

## 3. Tracer bullets（ordered by dependency）

### T1. `[implementation]` harness 协议扩展 — thinking_delta + tool_call_start.id

- **Affects**: `src/harness/stream.ts` + `src/harness/model-adapter/anthropic-adapter.ts`
  （wireStreamEvents）+ `src/harness/stubs/stub-model.ts`（如需脚本化事件形状）
  - `tests/harness/stream.test.ts` + `tests/harness/model-adapter/anthropic-adapter-stream.test.ts`
- **Acceptance**:
  - `HarnessStreamEvent` 新增 `{ type: "thinking_delta"; text: string }`；
    `tool_call_start` 增加 `id: string`（内部协议 pre-release，直接改形状）。
  - `wireStreamEvents`：SDK `content_block_delta` 且 `delta.type === "thinking_delta"` → emit
    thinking_delta（空 delta 丢弃）；`content_block_start` tool_use → emit 含 block.id。
  - adapter-stream 测试新用例：thinking delta 发射顺序 + 空 delta 抑制 + tool_call_start 带 id。
  - `npm run typecheck` 零错误；相关 vitest 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → commit

> 边界：thinking 不做 start/stop 事件（首 delta 即开始；turn 终稿 blocks 为 SSOT）。
> redacted_thinking 不进流式（无 delta 可发；终稿面板已有占位）。
> input_json_delta 仍不扩展（工具 input 展示维持 postToolUse 通道，本阶段不做流式 input）。

### T2. `[implementation]` TUI 用户消息即时回显

- **Affects**: `src/tui/session-state.ts`（新增 `userMessageEchoed` reducer action）
  - `src/tui/app.tsx`（sendTurn 接线）+ `src/tui/message-rows.ts` / `estimateMessageRows`
    兼容性检查（用户消息行高计入已有路径，理论上零改动）
  - `tests/tui/session-state.test.ts` + `tests/tui/app.test.tsx`（或 stream-draft-integration）
- **Acceptance**:
  - `userMessageEchoed(session, text)` 返回 messages 追加
    `{role:"user", content:[{type:"text",text}]}` 的新状态（Object.freeze 纪律）。
  - submit 后、任何 delta 到达前，用户消息已渲染在对话中。
  - turn 结束 / abort 重读文件后由落盘 messages 原子替换（中间态自动消失）。
  - 集成测试：submit → 立刻断言用户文本可见（turn 未完成时）→ 完成后仍在。
  - 守卫测试：可见用户消息不含 system prompt 注入内容（harness 内部 query 不上 UI）。
- **Per-ticket loop**: tdd → typecheck+tests → commit

> abort 语义：cancelled turn 不落盘 → 重读后用户消息回退消失 + 「已打断」提示（与既有 DROP 语义一致，不加额外状态）。

### T3. `[implementation]` thinking 流式草稿 + 折叠面板

- **Affects**: `src/cli/stream-draft.ts`（thinking buffer + `thinkingMasked()`）
  - `src/tui/app.tsx`（onStream thinking_delta 接线 + state）
  - `src/tui/chat-view.tsx`（流式 thinking 面板：默认折叠摘要行 `[思考] 思考中…`，
    `thinkingExpanded` 时展开流式内容，复用既有 `/thinking` 全局开关）
  - `src/tui/message-rows.ts`（滚动窗口行数联动：流式 thinking 折叠=1 行）
  - `tests/cli/stream-draft.test.ts` + `tests/tui/stream-draft-integration.test.tsx`
- **Acceptance**:
  - stream-draft：thinking 与 text 双 buffer，各自 masked()（SC20 一致性）；
    reset/subscribe 语义不变。
  - 集成测试：thinking_delta 流式 → 折叠摘要行可见；/thinking 展开 → 流式内容可见；
    turn 结束 → 流式面板消失，终稿 thinking blocks 面板接管。
- **Per-ticket loop**: tdd → typecheck+tests → commit

### T4. `[implementation]` 工具调用实时状态（start→运行中→完成配对）

- **Affects**: `src/tui/app.tsx`（liveToolCalls state：onStream tool_call_start 追加
  `{id,name,status:"running"}`；postToolUse TuiToolEvent 按 tool_use_id 配对转 ok/failed）
  - `src/tui/chat-view.tsx`（live 工具区渲染从纯字符串行升级为状态行：
    运行中 `[运行中] name`；完成复用 `formatLiveToolEvent` 摘要）
  - `src/tui/tool-summary.ts`（如需运行中格式化 helper）
  - `tests/tui/app.test.tsx` 或新集成文件
- **Acceptance**:
  - stub turn：tool_call_start 到达 → 「运行中」行立即可见（工具未完成时）；
    postToolUse 到达 → 同条目变 ok/failed 摘要行。
  - TuiToolEvent 缺 tool_use_id 时（向后兼容）落回现行字符串行追加。
  - 集成测试锁定两态时序。
- **Per-ticket loop**: tdd → typecheck+tests → commit

### T5. `[implementation]` 渲染节流 + React 并发防御

- **Affects**: `src/cli/stream-draft.ts`（append 内 50ms/384 字符 notify 批处理；
  reset 取消 pending timer；timer.unref() 不阻塞进程退出）
  - `src/tui/app.tsx`（subscribe 回调 setDraftsMasked 包 startTransition）
  - `src/tui/chat-view.tsx`（useDeferredValue(draftsMasked) 渲染）
  - `tests/cli/stream-draft.test.ts`（fake timers：批合并 / 384 早flush / reset 取消）
  - chat REPL 消费端回归（`tests/cli/chat-session.test.ts` 既有绿）
- **Acceptance**:
  - 300 个连续 delta → listener 通知次数 ≤ ceil(时间窗) 量级（断言批合并生效，非每 delta 一次）。
  - ≥384 字符累积立即 flush（不等 50ms）。
  - reset() 后 pending timer 不再 notify。
  - `npm test` 全绿（chat 侧节流后 SC20 遮蔽测试仍过）。
- **Per-ticket loop**: tdd → typecheck+tests → commit

## 4. Dependency graph

```
T1 (协议扩展) → T3 (thinking 流式需要 thinking_delta 事件)
T1 → T4 (工具配对需要 tool_call_start.id)
T2 (用户回显) 独立
T5 (节流) 独立，但最后做（避免与 T3/T4 的 draft 行为测试互相干扰）
```

## 5. 并行性

T2 与 T1 无依赖可并行；T3/T4 依赖 T1；T5 最后。实施按单人串行（worktree 内），顺序 T1→T2→T3→T4→T5，每 bullet = 1 commit。

## 6. Out of scope

- input_json_delta（工具 input 流式展示）—— v2+。
- markdown 换 marked / string-width 替换 —— 独立票（benchmark roadmap #2/#3）。
- modal 体系 / 主题 / todo 面板 —— 独立票。
- web/serve 侧 thinking 流式（SSE 仍 501，non-goal 不变）。

## 7. Verification（plan done 判定）

1. `npm run typecheck` exit 0
2. `npm test` 全绿（新增测试 ≥ 5 类覆盖：正常/失败/边界/权限无关但含空输入/并发时序）
3. `git log --oneline` 5 commits，每个对应一个 tracer bullet
4. code-review 双轴（arthurpower:code-review）High = 0
5. push + PR
