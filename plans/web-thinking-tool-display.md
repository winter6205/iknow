# Web UI 思考/工具/代码块显示 + 思考开关强度 — 实施计划（ACR 门禁）

**来源**: 用户任务（2026-08-05）：web 界面加入思考状态/思考内容（默认折叠）、工具使用显示、代码块显示、思考开关与强度，并对已实现功能做完善（trace 除外）。完成后 push + PR。
**侦察输入**: 3 个 Explore 子代理（web 前端 / session-api / harness+docs）+ 关键源码核对。
**事实基础**: #144 Resolution / PR #157（harness thinking blocks 已全落地：adaptive + effort，全字段进权威历史，env SSOT `IKNOW_LLM_THINKING*`；web UI 展示被显式列为后续票）。

## 现状事实（侦察结论）

1. harness：thinking/redacted_thinking block 全字段（含 signature/data）进 `RunResult.messages` 权威历史；`finalText`/`texts` 不含 thinking；协议冻结 `stream:false`；无事件回调。
2. session-api：wire DTO 仅 `{finalText, stopReason, turnCount}`；thinking/tool 数据被 `projectMessagesToTurns`/`toTurnDto` 投影层裁掉（进程内与落盘文件都有）；SSE `/events` 501 保留；无运行时设置端点；adapter 在 `cachedDeps` 全局复用。
3. web：~2100 行 React 19 + Vite 6 + Tailwind 4 SPA；零 markdown/thinking/tool/SSE 痕迹；`AgentCard.renderBody` 占位未实现；wire 镜像 `web/src/api/types.ts` 同形；web 包内禁测试框架（spec A8/A10），纯函数测试走根 vitest `tests/web/`。
4. 约束：`LoopTrace` 严格不含 payload（CONTEXT.md 词条）；thinking `data`/`signature` 属 replay 材料，**不得上线展示**。

## 范围裁决

**In scope**:

- wire 加法式扩展：`TurnAnswerDto` 可选 `thinking`（text 列表 + redacted 计数）与 `toolCalls`（name/input 预览/output 摘录 + 截断标记）；postMessage 与历史回放（GET session / projectMessagesToTurns）共用同一投影。
- 每请求 thinking 覆盖：`PostMessageRequest` 可选 `thinking: { mode, effort? }`；hub 收到覆盖时按回合重建 adapter（共享 client/model/maxTokens/temperature），无覆盖走缓存 deps。env 仍是默认值 SSOT。
- 前端：markdown 渲染（react-markdown + remark-gfm + rehype-highlight）+ 代码块（语言标签 + 复制按钮）；思考状态指示 + thinking 内容默认折叠展开；tool 调用卡片列表；思考开关 + 强度选择器（localStorage 持久化，随请求下发）。
- 已有功能完善（非 trace）：`renderBody` 占位实装；非 completed stopReason 的停止原因提示；AgentCard 元信息（turnCount）展示。

**显式排除（Out of scope）**:

- SSE `/events` 实现（设计文档 non-goal，501 保留，独立票）——"思考状态"= 请求在途指示 + 回合级完整展示，非 token streaming。
- G2 evidence 字段回 wire（spec 022 退役，独立票）；trace（用户排除）；ACI 工具生产接线（task #14 独立票）；鉴权/持久化/多实例。
- thinking `signature`/`data` 上 wire（replay 材料，仅 redacted 计数）。
- `ask` JSON 通道与 CLI 投影变更（行为零变化）。

## 受影响文件清单（affects）

> 实际落盘清单（`git diff 8d9c36a..HEAD --name-status`）— 计划中此处的早期版本与最终 diff 之间的差异以 `code-review` 整改补登在 §post-implementation 内。

- affects: plans/web-thinking-tool-display.md（本文件）
- affects: src/session-api/contract.ts
- affects: src/session-api/turn-projection.ts（新增）
- affects: src/session-api/thinking-override.ts（新增，ACR 整改）
- affects: src/session-api/hub.ts
- affects: src/session-api/http.ts
- affects: src/session-api/store/schema.ts（接受 `thinking` / `redacted_thinking` 块落盘，配套 #120 v2 schema）
- affects: src/config/env.ts（无改动）
- affects: tests/session-api/turn-projection.test.ts（新增）
- affects: tests/session-api/thinking-override.test.ts（新增）
- affects: tests/session-api/store/schema.test.ts（新增）
- affects: tests/session-api/hub.test.ts
- affects: tests/session-api/contract.test.ts
- affects: tests/session-api/http.test.ts
- affects: web/package.json
- affects: package-lock.json（用户已显式授权加依赖）
- affects: web/src/api/types.ts
- affects: web/src/api/client.ts
- affects: web/src/App.tsx（StopNotice 接入 footer；非 ChatHeader 接线）
- affects: web/src/components/MarkdownBody.tsx（新增）
- affects: web/src/components/CodeBlock.tsx（新增）
- affects: web/src/components/ThinkingBlock.tsx（新增）
- affects: web/src/components/ToolCallList.tsx（新增）
- affects: web/src/components/ThinkingControls.tsx（新增）
- affects: web/src/components/SendingIndicator.tsx（新增，状态指示）
- affects: web/src/components/StopNotice.tsx（新增，T6 元信息）
- affects: web/src/components/AgentCard.tsx
- affects: web/src/components/MessageList.tsx
- affects: web/src/hooks/useSessionChat.ts
- affects: web/src/lib/thinking-settings.ts（新增，纯函数）
- affects: web/src/lib/stop-reason.ts（新增，T6 文案映射纯函数）
- affects: web/src/styles/tokens.css（hljs 主题变量）
- affects: web/src/styles/global.css（hljs token CSS 变量补充）
- affects: tests/web/thinking-settings.test.ts（新增）
- affects: tests/web/stop-reason.test.ts（新增；非 plan 中提到的 `turn-view.test.ts`，因抽出的是 stop-reason 纯函数而非 turn view）
- affects: docs/design/frontend-stack-upgrade-v1.md（决策补录 §0.1；code-review 整改后再加 §0.1.6）
- affects: docs/STATUS.md
- affects: CHANGELOG.md

## 计划与最终 diff 的偏差（post-implementation 补登）

- **`hub.ts` 增量约 50 行**（`projectMessagesToTurns` 新增内嵌于此；含 `findTurnSliceEnd` / `findFinalTextInSlice` 辅助）。计划预估"行数不显著增长"被低估——`hub.ts` 是 thinking/toolCalls 投影在 history-replay 路径上的唯一消费者（http.ts 不做投影），投影职责无法仅由 turn-projection.ts 完全承担。
- **App.tsx footer 接线**取代了计划中提到的 ChatHeader.tsx。`StopNotice` 接在 `App.tsx` 而非 ChatHeader 是 T6 实施时的小调整，与 `renderBody` 占位实装一并记录。
- **`turn-view.test.ts` 未创建**。T6 抽出的纯函数是 `web/src/lib/stop-reason.ts`（stopReasonLabel + STOP_REASON_LABELS），相应测试落在 `tests/web/stop-reason.test.ts`。
- **T2 acceptance**：`hub.ts` 实际增量 ≈ 50 行（与计划中"hub.ts 仅薄委托"的承诺冲突；`projectMessagesToTurns` 是新增在 hub.ts 内的纯函数投影，不属于 http.ts）。

## ACR 5-verdict（pre-implementation gate）

- bounded-context-guardian: **yes** — 新投影模块落 `src/session-api/`（投影是该 bounded context 固有职责）；前端组件全在 `web/`；harness 零 diff（`RunResult.messages` 已带全量数据，不改 loop/adapter 内部）；无循环依赖、无反向依赖（session-api→harness 类型是既有方向）。
- defensive-contract-validator: **yes** — 五边界类全覆盖计划：空（无 thinking/tool 回合 → 可选字段省略）/ 非法输入（thinking 覆盖非法值 → 400 validation，沿用嵌套 envelope）/ 溢出（thinking 文本与 tool output 截断常量 + 用例）/ 并发（hub.serialize 既有序列化；adapter 重建无共享可变）/ 异常（覆盖构建失败 → internal envelope）；纯函数走根 vitest（web 包禁测试框架的 spec 约束遵守）。
- error-handling-enforcer: **yes** — 新失败路径全部 typed：校验走 `ValidationError`→400（既有 kind）；内部失败走既有 internal envelope；前端沿用既有 error phase；无 null-on-failure / 空 catch。
- complexity-anti-drift: **yes（ACR 整改后）** — 初评 no（hub.ts 522 行 / http.ts 439 行超 ≤300 阈值，且计划自报阈值与评审阈值不一致）。整改：新增逻辑全部落新模块——投影入 `turn-projection.ts`（纯函数）、thinking 覆盖构建与 wire 校验入 `thinking-override.ts`；hub.ts / http.ts 只保留薄委托（各 ≤ 若干行增量，不再增长主体职责）；hub.ts / http.ts 既有超标面为 diff 前 tech debt，不属本 diff 失败项但不再加剧。新模块函数 ≤ 30 行、文件 ≤ 300 行（评审阈值）；前端新组件各自单一职责，AgentCard 增肥部分拆入子组件。
- minimal-change-verifier: **yes** — 1 commit = 1 logical task（见 Tracer bullets）；新依赖 YAGNI 论证：react-markdown/remark-gfm/rehype-highlight 为成熟最小集（AST→组件可控、无运行时 XSS 风险面），手写 markdown 解析器体积与正确性风险显著更高；lockfile 变更已获用户显式授权（"可以加依赖"）。

**冲突检查**: bounded-context 与 minimal-change 无冲突——所有改动落在既有 capability slice（session-api / web），无新 bounded context，不需拆分 context；按逻辑任务拆 commit 即可。

## Tracer bullets（依赖图：T1 → T2 → T3 → T4 → T5 → T6 → T7）

### T1 `[decision+impl]` wire DTO 加法式扩展 + 投影纯函数

- contract.ts：`TurnAnswerDto` + 可选 `thinking` / `toolCalls` 视图类型；新模块 `turn-projection.ts`：从 `AnthropicNativeMessage[]` 投影 thinking 文本（redacted 计数、截断）、tool 调用视图（name、input JSON 预览、output 摘录 + truncated 标记），应用 output mask。
- 测试：turn-projection.test.ts（五边界类）+ contract.test.ts 扩展。
- Acceptance：`npm test` 全绿；现有 wire 消费者零回归。

### T2 `[impl]` hub/http 接线：postMessage 投影 + 每请求 thinking 覆盖（ACR 整改：拆分）

- **新模块 `thinking-override.ts`**（ACR complexity 整改）：thinking 覆盖参数的 wire 解析与值域校验（非法 → ValidationError）、按回合构建一次性 adapter（复用 ensureDeps 的其余 deps，仅替换 adapter）。hub.ts / http.ts 只调用，不承载逻辑。
- hub.toTurnDto / projectMessagesToTurns 消费 turn-projection；postMessage 支持可选 thinking 覆盖。
- 测试：thinking-override.test.ts（新，校验/构建）+ hub.test.ts（覆盖生效/缺省走 env/历史回放带新字段）+ http.test.ts（非法值 400）。
- Acceptance：默认（无覆盖）行为与现 wire 字节一致 + 新可选字段；http.ts 仅薄接线；hub.ts 实际增量 ~50 行（`projectMessagesToTurns` turn-slice 投影 + T1 投影消费，post-implementation 补登）；`npm test` 全绿。

### T3 `[impl]` web markdown + 代码块渲染

- 依赖：react-markdown + remark-gfm + rehype-highlight；MarkdownBody + CodeBlock（语言标签 + 复制按钮）；AgentCard 接 renderBody；tokens.css 引 hljs 主题变量。
- Acceptance：`web:build` 通过；assistant 文本按 GFM 渲染，代码块高亮 + 复制可用。

### T4 `[impl]` web thinking 显示 + 工具显示

- ThinkingBlock（状态指示 + 内容默认折叠/展开 + redacted 占位）+ ToolCallList（名称/input 预览/output 摘录/截断标记）；useSessionChat 消息模型带新字段；api/types.ts 镜像。
- Acceptance：`web:typecheck` + 根 vitest（视图纯函数若有）通过。

### T5 `[impl]` web 思考开关 + 强度控制

- ThinkingControls（开/关 + effort 档位选择，localStorage 持久化，`thinking-settings.ts` 纯函数）；client.ts/useSessionChat 随请求下发覆盖参数。
- 测试：tests/web/thinking-settings.test.ts。
- Acceptance：开关/强度变更即时影响下一次请求参数；刷新后持久。

### T6 `[impl]` 已有功能完善（非 trace）

- 非 completed stopReason 停止原因提示；AgentCard turnCount 元信息；其他侦察发现的小项（UI 残余引用清理等，限既有面）。
- Acceptance：`npm test` + `web:build` 全绿。

### T7 `[docs]` 文档与 CHANGELOG

- frontend-stack-upgrade-v1.md 决策补录（markdown/thinking 渲染策略、依赖论证）；STATUS.md 现状更新；CHANGELOG.md。
- Acceptance：文档与实现一致。

## 验收总门

1. `npm test`（根 vitest 全量）全绿；
2. `web:typecheck` + `web:build` 通过；
3. 浏览器实测（playwright-cli skill）：真实 `iknow serve` 上验证 markdown/代码块/thinking 折叠/tool 卡片/开关持久化；LLM 路径缺 `NINE_ROUTER_KEY` 时以 stub/mock 验证渲染面并如实记录 Not run；
4. arthurpower:code-review 双轴评审通过后再 push + PR（`gh pr create --draft`）。
