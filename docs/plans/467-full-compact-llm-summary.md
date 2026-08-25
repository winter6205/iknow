# #467 压缩升级：纯截断 → LLM 结构化摘要（full compact）+ session.summary 改名

> Issue: https://github.com/winter6205/iknow/issues/467
> ACR gate: 首轮 BLOCKED（defensive / error-handling / complexity / minimal-change），本 plan 按 4 项 FAIL 修订后重跑。

## Destination

把压缩从「纯截断 + 边界占位符」升级为「LLM 结构化摘要压缩（上游参考实现 full compact 同款）」，并把 `session.summary` 字段改名 `session.title`（消除误导名）。proactive/reactive 双触发路径（`shouldAutoCompact` / `PromptTooLongError`）保留不变，只替换/增强压缩执行体。

## 现状盘点（探索结论）

- **Step 1（taskFocus 边界渲染）已落地**：#458 T7（`hub.ts:1136 renderTaskFocusBoundary` + `loop-engine.ts:282 applyCompactAttachment` + `boundaryAttachment` 缝），测试 `tests/session-api/hub-taskfocus-compact.test.ts`。**本 plan 不再包含 Step 1。**
- Step 2（LLM 摘要）= 主要工作。
- Step 3（summary → title 改名）= 跨层改名，独立 commit。

## 参考来源（提示词模板，不自写）

1. **Claude Code full compact prompt**（社区提取，verbatim 结构）：`NO_TOOLS_PREAMBLE` + 9 节 `BASE_COMPACT_PROMPT`（Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step）+ `NO_TOOLS_TRAILER`；产物 `<analysis>` 草稿 + `<summary>` 正文。来源：github.com/codeaashu/claude-code `src/services/compact/prompt.ts` + Piebald-AI extraction（含 security-relevant verbatim 保留条款，采纳）。
2. **本仓 `upstream-ref/src/<baseline>/services/compact/__init__.py`**（MIT，同族移植）：`get_compact_prompt` / `format_compact_summary`（strip analysis + 提取 summary）/ `build_compact_summary_message`（"This session is being continued…" 包装）/ `compact_conversation` 流程（microcompact → split older/recent → LLM → 重组）。
3. 采纳决策：采用上游参考实现的 9 节模板（与 Claude Code 同结构、MIT 可复制），加上 Piebald 版的 security-relevant 两条（安全约束逐字保留 + user 消息归属甄别）。注入消息 wrapper 沿用 Claude Code 的 "This session is being continued from a previous conversation that ran out of context…" 语义。
4. 授权说明：模板结构与 MIT 参考一致；文本级采用上游参考实现版本（不逐字复制 Anthropic 闭源 bundle 提取文），文件头注明来源。

## Commit 切分（minimal-change-verifier FAIL 修复：2 个独立 logical task）

- **Commit A**（feat）：full compact LLM 结构化摘要压缩。
- **Commit B**（refactor）：session.summary → session.title 改名 + 迁移。
- 两 commit 顺序 A → B，各自独立通过 pre-commit。

## Commit A 设计

### 新文件 `src/harness/compress/full-compact.ts`

每函数单一职责（complexity-anti-drift UNCLEAR 修复）：

| 函数                                              | 职责                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildCompactPrompt(customInstructions?: string)` | 纯字符串拼装：NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT + 可选 Additional Instructions + NO_TOOLS_TRAILER                                                                                                                                                                                        |
| `extractCompactSummary(raw: string)`              | 纯解析：strip `<analysis>` 块 → 提取 `<summary>` 内容；无 `<summary>` 包裹 → 取 strip 后全文（Postel）；空 → `undefined`                                                                                                                                                                       |
| `splitForCompaction(messages, keepRecent)`        | 纯切分：复用 window.ts 的 tool-pair 配对纪律，返回 `{ dropped, kept }`（dropped 为空 → `undefined` = 无需压缩）                                                                                                                                                                                |
| `buildCompactedMessages(opts)`                    | 纯组装：boundary 消息（摘要 user 消息，带 "This session is being continued…" wrapper）+ kept；与 `compactMessages` 共用 tool-pair 校验                                                                                                                                                         |
| `runFullCompact(opts)`                            | 编排：调用 `opts.adapter.step`（state = dropped + prompt user 消息，无 tools，turnCount 0）+ 可选 `opts.timeoutMs` 注入 timer + catch-all；返回 discriminated union。无默认 client-side 超时（wait 逻辑参考 Claude Code：压缩等模型自然完成；上限 = SDK 默认 HTTP timeout + 用户 signal 取消） |

### 错误处理（error-handling-enforcer FAIL 修复：typed discriminated union + exit criteria）

```ts
type FullCompactOutcome =
  | { kind: "summarized"; text: string; usage: TokenUsage | undefined }
  | { kind: "empty_response" }
  | { kind: "timeout" }
  | { kind: "adapter_failed"; message: string }
  | { kind: "signal_aborted" };
```

Exit criteria：

- `summarized` 且 text 经 `extractCompactSummary` 非空 → 采用摘要；
- 其余 3 种 → 调用方回退现有纯截断（placeholder）路径，**绝不阻塞主回路**（对齐 epilogue summary ADR-0011 纪律）；`signal_aborted` 例外——wait 逻辑参考 Claude Code：压缩中取消 = 会话保持原样，不做破坏性 fallback；
- 不设默认 client-side 超时（2026-08-19 实测调整，参考 Claude Code + 上游参考实现双源：实测 27KB dropped ~17s 占旧 25s 的 67%，上游参考实现的 25s/attempt + retries 模型在长上下文下不足；Claude Code 不设 client-side 超时，靠 SDK 默认 HTTP timeout + 用户 signal 兜底）。`timeoutMs` 保留为注入缝供测试 / 显式 caller 使用；产物 `docs/handoff/i467-full-compact/`；
- 等待 UX（参考 Claude Code）：runFullCompact 透传 `opts.onStream`，emit `compaction_started` / `compaction_completed` / `compaction_failed` / `compaction_cancelled` 事件 + adapter text_delta 直透，宿主可渲染进度。

### 触发点接入（保留双触发路径语义）

1. **loop-engine**：`applyCompactAttachment` 改 async（两处调用点 reactive line ~773 / proactive line ~1396 同步改 await）。执行序：
   - `splitForCompaction` → dropped 为空 → 原样返回（不变）；
   - dropped 在场 → `runFullCompact`（best-effort，无默认超时；失败 → `compactMessages` placeholder）；
   - 成功 → `buildCompactedMessages`（摘要 user 消息）+ boundaryAttachment 注入；
   - 失败 → 原 `compactMessages` placeholder 路径（行为与现 master 等价）+ boundaryAttachment 注入。
   - trace：摘要轮走 `deps.trace?.recordLlmCall`（status ok/error，对齐 epilogue summary 记录模式，`loop-engine.ts:1516` 同款）。
2. **hub.compactSession（手动 /compact）**：同样先试 full compact（用 `cachedDeps.adapter`），失败回退 `compactMessages`。保持幂等 no-op 语义（无可压缩 → 不落盘）。

### 边界（issue #467 边界条款）

- 不碰 #459 的 taskFocus 存储/更新策略（只消费渲染，且渲染已由 #458 落地）；
- 不碰 verify 闭环本体（#128/#433/#449）；
- harness 不 import session-api（boundaryAttachment 闭包缝模式不变）；
- 双触发路径（proactive `shouldAutoCompact` / reactive `PromptTooLongError`）与手动路径共用同一 full compact 执行体，不分叉压缩逻辑。

### Commit A 测试矩阵（defensive-contract-validator FAIL 修复：5 类边界 × 每函数）

`tests/harness/compress/full-compact.test.ts`（新）：

- **正常路径**：stub model 返回 `<analysis>...</analysis><summary>...</summary>` → 提取 summary 段；buildCompactedMessages 输出 = 摘要消息 + kept（tool 配对完整）。
- **失败路径**：adapter reject → `adapter_failed`；adapter 返回空 text → `empty_response`；调用方回退 placeholder（byte-equivalent 断言 vs 现 compactMessages）。
- **边界条件**：messages ≤ keepRecent → split 返回 dropped undefined（passthrough，不调模型）；`<summary>` 标签缺失 → 取 strip-analysis 全文；空串输入。
- **权限不足**：signal 已 abort → `signal_aborted`，不发起模型调用。
- **空输入/非法输入**：空 messages 数组；customInstructions 空串/纯空白 → 不附加段落。
- **并发/重复**：timeout 触发后 adapter 迟到 resolve → 不覆盖已回退结果（Promise.race + abort 纪律同 `runSummaryWithTimeout`）。
- 超时注入缝：`timeoutMs` 可覆写（测试用小值）。

`tests/harness/compress/integration.test.ts`（扩）：

- proactive 触发 → full compact 摘要注入（trace recordLlmCall status ok 双轨 assert：trace-based + NoopTraceService deepEqual 基线，守 test.md "Trace as assert surface"）；
- full compact 失败 → 回退 placeholder（行为与改前一致）。

`tests/session-api/_compact-integration.test.ts`（扩）：手动 compactSession LLM 路径 + 回退路径。

## Commit B 设计（session.summary → session.title）

### 改名范围（defensive-contract-validator FAIL 修复：一次迁全所有读写点）

- `src/session-api/store/schema.ts`：`SessionFileV1.summary` → `title`；`extractSummary` → `extractTitle`（语义不变：首条 user text trim + 80 字符）；`sanitizeSessionFile` 回填：`summary`（旧盘）→ `title`，旧字段不保留到输出（向前迁移，v6 语义但 schemaVersion 保持 5 —— sanitize 本就把 ≤5 文件重写为 CURRENT；判定 `typeof obj["summary"] === "string"` 时优先读旧值）。
- `validateSessionFile`：`summary` 字段本就不在硬校验列表（v2 backfill 字段），改名后同样不硬校验 `title`（sanitize 兜底）。
- `src/session-api/store/session-store.ts`：`SessionListEntry.summary` → `title`（list + tryListEntry 两处）。
- `src/session-api/store/checkpoint.ts`：`extractSummary` import（line 24）+ `summary: extractSummary(messages)` 写点（line 189，rewindFile 重算）→ `title` / `extractTitle`。
- `src/session-api/store/index.ts`：`extractSummary` re-export（line 16）→ `extractTitle`。
- `src/session-api/hub.ts`：`extractSummary` import（line 66）+ `summary: ""` 两处初始化（line 617/1004）+ `summary: extractSummary(...)` 两处（line 1058/1244）→ `title` / `extractTitle`。
- `src/cli/chat-session.ts`：`extractSummary` import（line 57）+ line 661/814/844 三处 → `title` / `extractTitle`。
- `src/tui/app.tsx`：`extractSummary` import（line 154）+ `const summary = extractSummary(messages)`（line 1902，session 列表 draft 行）→ `extractTitle`。
- `src/tui/list-view.tsx`：`entry.summary` 两处 → `entry.title`（过滤谓词 + 渲染）。
- 其他消费点全量 grep 清零（**含 tests/**）：`rg "\.summary\b|\bsummary:|extractSummary" src/ tests/ | grep -v stop_summary | grep -v stopSummary | grep -v toolSummary | grep -v subagent | grep -v SubAgent | grep -v "harness/verify" | grep -v "process-chat-line-verify" | grep -v "tui/designs"`。
  **不改名（out-of-scope，不同语义域）**：stop_summary 事件（ADR-0011 停因摘要）；toolSummary（工具摘要渲染）；`SubAgentEnvelope.summary` / `ClassifierEnvelope.summary`（subagent/verify 域的不同类型字段：`src/harness/subagent/*`、`src/harness/verify/verify-loop.ts`、`tests/subagent/*`、`tests/harness/verify/*`（classifier-abort/classifier-loop/classifier-sc7/judge-input 等）、`tests/cli/process-chat-line-verify.test.ts`、`tests/session-api/subagents-endpoint.test.ts`、`tests/web/subagent-*`、`tests/web/flow-tree.test.ts:291`、`tests/integration/subagent-chain.test.ts`）；`src/tui/designs/*` + `src/tui/designs/_contract.ts` 的 `meta.summary`（thinking-design 元数据，与 session 无关）。
- `src/tui/rewind-picker.tsx:78`：注释引用 `extractSummary` 语义，随改名同步为 `extractTitle`（cosmetic，同 commit）。
- 测试侧枚举（一次迁全，编译级 break 全修）：
  - `tests/session-api/store/sanitize.test.ts`（extractSummary describe 块 + backfill 断言）
  - `tests/session-api/store/checkpoint.test.ts`（import + extractSummary 用例）
  - `tests/session-api/store/boundary.test.ts`
  - `tests/session-api/store/session-store.test.ts`
  - `tests/session-api/store/schema.test.ts`（`valid` fixture `summary: ""` → `title: ""`；stale comment 同步）
  - `tests/session-api/hub.test.ts`
  - `tests/session-api/cross-entry-consistency.test.ts`
  - `tests/session-api/_compact-integration.test.ts`
  - `tests/session-api/http.test.ts`
  - `tests/session-api/goal-*.test.ts`
  - `tests/session-api/contract.test.ts`
  - `tests/session-api/_end-to-end-fresh.test.ts`（fixture `summary: ""` → `title: ""`）
  - `tests/session-api/hub-taskfocus-compact.test.ts`（fixture `summary: ""` → `title: ""`）
  - `tests/cli/chat-session-resume.test.ts`、`tests/cli/chat-session-user-text.test.ts`、`tests/cli/goal-slash-runtime.test.ts`、`tests/cli/issue-473-stale-taskfocus.test.ts`
  - `tests/tui/{keyboard,input-history,stream-draft-integration,hub-bridge,list-view-scroll,rewind,app,tui-cross-entry,interrupt-notice,slash-hint-new-session}.test.{ts,tsx}`
  - `tests/tui/session-state.test.ts`（`sampleFile` fixture `summary: "你好"` → `title: "你好"`）
  - `tests/tui/designs.test.tsx` 的 `meta.summary` 是 thinking-design 元数据，**不改**。

### Commit B 测试

- `tests/session-api/store/sanitize.test.ts`（扩）：legacy `summary` 字段文件 → load 后 `title` = 旧值；`summary` 缺失 → 从 messages 重算。
- TUI/CLI 既有测试（`tests/tui/*`、`tests/cli/chat-session-*`）中 `summary` 期望值同步改 `title`。

## 验证矩阵

- `npm test`（unit + harness + integration 全量）。
- Commit A 完成后先跑 `npm run test:changed`（pre-commit 同款），commit B 后跑全量 `npm test`。
- LLM 触点（adapter 调用契约未改，只新增 step 调用形态）：`npm run test:real-llm` 缺 key 则按 test.md 记 Not run。

## 风险

1. **压缩调用阻塞主回路**：proactive compact 发生在 turn 循环内，等待期间 turn 被阻塞。缓解：run 级 signal 透传进压缩等待（用户可取消，signal_aborted → 会话原样 + cancelled stop）；无默认 client-side 超时（SDK 默认 HTTP timeout + 用户 signal 兜底；长上下文用户可经 Esc/Ctrl+C 中止）。实测 27KB dropped ~17s（i467 smoke）。
2. **摘要质量回归**：摘要丢关键信息。缓解：9 节结构 + "All user messages" 节保留用户原话；失败回退截断路径不劣于现状。
3. **改名迁移**：旧 session 文件 `summary` 字段 → sanitize 回填 `title`；round-trip 测试钉住。
