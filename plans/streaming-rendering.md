# Plan: 流式接入 — TUI 消费端 + chat 渲染共享层（#188 + #198）

> 来源：wayfinder 地图 #201（D1-D6 已 close）+ ACR 5-verdict 审查。
> 用户裁决：跳过 spec（gh-22 skip path），决策已足够，直接落地计划。
> Tracker: GitHub issues（`ready-for-agent` 标签）+ 本地 plan 文件。

## 1. Destination

让 iknow 的终端入口（`iknow chat` + `iknow tui`）共享一套流式渲染语义——TUI 接入流式（#188），chat 还掉 fd 拼接债（#198）。web SSE 记为 out of scope（destination 重画到 C 时回来）。

## 2. ACR 5-verdict（architecture-change-reviewer · 2026-08-06）

- bounded-context-guardian: **yes** — `onStream` 是 `HarnessStreamEvent → void` typed 回调，SSOT 留在 harness（stream.ts），session-api 只透传、tui 只消费，stream-draft.ts 是共享叶子层无反向依赖，边界未破。
- defensive-contract-validator: **yes** — 空 delta 不 emit（anthropic-adapter.ts:539）+ safeEmit 吞观察者异常（530-536）+ D6 abort→reset stream-draft + D4 双 buffer(raw/masked) 尾部重 mask，5 类边界（空/异常/abort/并发）均有决策覆盖。
- error-handling-enforcer: **yes** — abort 路径定义为 reset+idle+提示（D6），观察者异常按 ADR-0003 safeTrace MUST NOT throw 吞掉（已实现于 wireStreamEvents），无未 typed 失败路径。
- complexity-anti-drift: **unclear → 已折入 T2 约束** — 50ms/384 字符批处理与 useDeferredValue 是两套节流：**分层明确**（批处理=生产端主节流，useDeferredValue=消费端防御兜底，React 一行 hooks 不新增复杂度）。双 buffer + useSyncExternalStore 在 stream-draft.ts 内收敛（≤30 行/函数目标）。
- minimal-change-verifier: **unclear → 已折入 T5** — D4 的「chat 本期也切」拆成**独立 commit**（T5），不与 T2/T3/T4 混合。B1 的 5 个关注点各为独立 commit。

**OVERALL: PASS-with-notes**（原 BLOCKED → 折入 plan 后通过）

## 3. Tracer bullets（ordered by dependency）

### T1. `[decision]` 选定 stream-draft.ts 物理落点

- **Affects**: 无（纯决策）
- **Acceptance**: 决策记录落档于 `plans/streaming-rendering.md` 的 T1 区块；选定 `src/cli/`（共享层，chat + TUI 都 import）或 `src/tui/`（TUI 独占）或 `src/` 顶层。
- **Per-ticket loop**: 决策 ticket → 记录 → close

> 决策倾向：`src/cli/`（chat + TUI 都 import，B1 共享语义层最自然的落点；`src/cli/format.ts` 已持有 buildOutputMask，stream-draft 与 mask 同层）。最终以 T1 关闭时的裁决为准。

> **T1 裁决（closed 2026-08-06）**:选定 `src/cli/stream-draft.ts`。
> 依据：`src/cli/` 已是共享渲染语义层——`format.ts` 持有 `buildOutputMask`（SC20 遮蔽）、`renderAssistantAnswer`（thinking 展示）、`chat-session.ts` 持有 `createStreamPreviewSink`（chat 流式预览）；TUI 经 `src/tui/` 独立 import `src/cli/` 模块无循环依赖（`src/cli/` 无反向依赖 `src/tui/`）。落 `src/tui/` 会把 mask 语义与 TUI 绑定，落 `src/` 顶层则与 `harness/` 边界混淆。stream-draft 与 mask 同层，T5 chat 切换可直接复用。

### T2. `[implementation]` 实现 stream-draft.ts 共享层

- **Affects**: `src/cli/stream-draft.ts`（新）+ `tests/cli/stream-draft.test.ts`（新）+ `src/cli/index.ts`（若存在 export 面）
- **Acceptance**: `npm run typecheck` 零错误 + `npx vitest run tests/cli/stream-draft.test.ts` 全绿。单测覆盖：正常路径（mask 命中）、跨 delta 边界（`sk-ab` + `c123`）、空 delta、无密钥值、reset、subscribe/unsubscribe 不泄漏。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

> 实现要点（D4 裁决）：纯累积 `{ append, masked, raw, reset, subscribe }`；尾部余量重 mask（O(N+delta)）；无 fd 无 React 依赖；≤30 行/函数、≤4 嵌套。
> 节流分层：stream-draft 内部 50ms/384 字符批处理（生产端主节流）；useDeferredValue 留给消费端防御（T4）。

### T3. `[implementation]` hub 层 onStream 透传（D2）

- **Affects**: `src/session-api/hub.ts` + `src/tui/hub-bridge.ts` + `src/tui/deps.ts` + `tests/session-api/hub.test.ts`（或现有 hub 测试）
- **Acceptance**: `hub.postMessage` 契约加 `onStream?: (event: HarnessStreamEvent) => void`，透传到 `run(opts.onStream)`；`src/tui/deps.ts` adapter 加 `stream: env.llm.stream === "on"`；hub 集成测试断言 TUI 路径真实走流式臂（delta 到达）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

> 这是最高 leverage seam：hub 一接通，TUI/serve/未来 SPA 全获得流式。`hub.postMessage` 返回值仍 `Promise<PostMessageResponse>`，`onStream` 是异步回调（D2 = A 闭包）。

### T4. `[implementation]` TUI 接入流式渲染（D3 + D4-r4 + D6）

- **Affects**: `src/tui/session-state.ts` + `src/tui/app.tsx` + `src/tui/chat-view.tsx` + `tests/tui/`（新增/扩展）
- **Acceptance**: `runTurnOnce` 构造 `createStreamDraft`，delta 进 `append()`，`useSyncExternalStore` 订阅 `masked()` setState 到 `draftsMasked`；turn 结束（`run()` 解决）→ commit `result.messages` 末帧 → 清 drafts；abort → `streamDraft.reset()` → UI 落回 idle + "已打断"提示。集成测试断言：流式时草稿累积、commit 后进 transcript、abort 后清空。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

> 实现要点：`session-state.ts` 加 `draftsRaw` + `draftsMasked` + `abortTurn` action；`app.tsx` 构造 observer（D2 的 onStream → stream-draft.append）；`chat-view.tsx` 渲染 `draftsMasked`（D4 遮蔽保证不泄漏密钥）+ `useDeferredValue` 防御兜底（ACR 反馈保留为防御层）。

### T5. `[implementation]` chat REPL 切换 stream-draft（D4-乙2 chat）

- **Affects**: `src/cli/chat-session.ts` + `tests/cli/chat-session.test.ts`
- **Acceptance**: `createStreamPreviewSink` 内部改用 stream-draft（`masked()` 写 stdout），工具提示仍 stderr；chat 流式路径 SC20 遮蔽生效（流式 delta 不再裸写）；`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

> ACR minimal-change 反馈折入：**独立 commit**，不与 T2/T3/T4 混合。chat 的 fd 直写（StreamPreviewSink）换成语义等价 + 遮蔽的 stream-draft 消费。

### T6. `[implementation]` thinking 终稿渲染 + 折叠 UI（D5）

- **Affects**: `src/tui/chat-view.tsx` + `src/cli/format.ts` + `src/cli/chat-session.ts` + `tests/tui/` + `tests/cli/`
- **Acceptance**: thinking blocks 从 `result.messages` 提取，默认折叠显示（无 emoji 字形约束），折叠/展开交互可用；chat 和 TUI 入口 thinking 默认折叠状态一致；`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

> 实现要点（D5 = D）：thinking 不增量流式（`HarnessStreamEvent` 维持最小集）；终稿时从 `result.messages` 提取 blocks 渲染 + 折叠控件；用户偏好持久化（localStorage/配置，与 web 对齐）；复用 `renderAssistantAnswer`（#152 T5 已实现 showThinking 开关）。

## 4. Dependency graph

```
T1 (decision) → T2 (stream-draft) → T3 (hub透传) → T4 (TUI接入) → T5 (chat切换) → T6 (thinking UI)
```

- T1 → T2：落点决定 stream-draft 物理位置
- T2 → T3：hub 透传需要 stream-draft 存在（onStream 事件到 buffer）
- T3 → T4：TUI 需要 hub 先接通 onStream
- T4 → T5：chat 切换复用 stream-draft 模块（T2 已建）
- T5 → T6：thinking 渲染复用 T5 的 chat stream-draft 通道

**Blockers**：T2 blocks T3/T4/T5；T3 blocks T4；T5 blocks T6。

## 5. 并行性

无并行——严格线性依赖（每个 T 消费前一个 T 的输出）。若 T1 落点裁决为 `src/tui/`（非共享），则 T3 可独立（不依赖 T2），T2 仍 block T4/T5。

## 6. Verification（plan done 判定）

1. `cat plans/streaming-rendering.md | grep -E "^\s*[0-9]+\."` — tracer-bullet 列表存在且编号
2. 执行后 `git log --oneline | head -N` — 每 bullet = 1 commit
3. `git diff --stat HEAD~N..HEAD` — diff scope 与 Affects 一致，无 scope creep
4. Final report: `成功 = plan has 6 tracer bullets, each with binary acceptance + one [decision]|[implementation] tag`

成功 = plan has 6 tracer bullets, each with binary acceptance + one [decision]|[implementation] tag
