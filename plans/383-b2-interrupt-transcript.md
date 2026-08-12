# Plan: B2 打断作为 transcript 事件（system role · schema v4）

**Goal:** 把 Ctrl+C 打断做成对话流一等公民——一条 `system`-role 消息 `Interrupted by user.` 进 transcript，随持久化/渲染/rewind 一起；schema v3→v4 落地。

**Architecture:** 落地 5 个跨层改动面，**全部按 additive / 单点守门原则**——扩 `AnthropicRole` 加 `"system"`（types.ts）、扩 schema role 白名单（schema.ts）、`buildMessageParams` filter 守门（adapter.ts）、TUI 补 system 分支（message-blocks.tsx）、hub/loop 统一 append 时序。每点 1 commit、串行落地。`checkpoints[]` 已有 `interruptReason`（cancelled/protocolError/timeout）承载诊断信息，system 消息只承载 UI 文案，不重复。

**Tech Stack:** TypeScript + vitest（单测）+ real-LLM e2e（archive/tests-real-llm/）· 沿用仓库现有色板/图标库（TUI warning 色）

**Spec link:** none（wayfinder map #383 Decisions-so-far 即 spec 来源——R1/G1/G2/G3/G4 5 张票 resolution 已闭环，含完整决策）

## Tasks (ordered by dependency)

每条 1 个 tracer bullet = 1 个 commit。依赖序：T1 是 schema/类型底座；T2/T3 依赖 T1 的角色扩；T4 依赖 T1+T2（provider 边界已守门才能放心 append）；T5 端到端验证。

### T1. `[implementation]` schema v4 additive 落地

**Affects:**

- `src/harness/model-adapter/types.ts:34` — `AnthropicRole` 加 `"system"`
- `src/session-api/store/schema.ts:60` — `CURRENT_SCHEMA_VERSION` 3→4
- `src/session-api/store/schema.ts:201-207` — `isValidMessage` role 白名单加 `"system"`
- `src/session-api/store/schema.ts` `sanitizeSessionFile` — 加 v3→v4 forward-compat 注释（无新增字段；老 v3 加载照常 sanitize 升 v4）
- 新增/扩展单测覆盖 role="system" 校验路径

**Acceptance (binary):**

- `grep -nE 'role:.*system' src/session-api/store/schema.ts` 返回至少 1 行命中 `isValidMessage`
- `grep -nE 'CURRENT_SCHEMA_VERSION = 4' src/session-api/store/schema.ts` 命中
- `grep -nE '"system"' src/harness/model-adapter/types.ts` 命中
- `npm test -- schema` 退出 0（含新增 `system` role 校验单测：合法 system 消息通过；非 user/assistant/system role 被拒）
- `npm run typecheck` 退出 0

**Commit:** 1 commit = this 1 task
**Status:** [ ] pending

---

### T2. `[implementation]` provider 边界守门

**Affects:**

- `src/harness/model-adapter/anthropic-adapter.ts:600-632`（`buildMessageParams`）— 加 `state.messages.filter(m => m.role !== "system")` 替换原 `state.messages as unknown as MessageParam[]` 强转
- invariant 注释（说明"system 项绝不上 wire：服务端拒收 + 语义错位，R1 #385"）
- 单测：mock SDK 验证含 `role: "system"` 的 messages 数组经过 buildMessageParams 后**不会**进入 wire body

**Acceptance (binary):**

- `grep -nE '\.filter\(.*role.*system' src/harness/model-adapter/anthropic-adapter.ts` 命中
- `grep -nE 'system.*绝不上 wire|R1.*#385|invariant' src/harness/model-adapter/anthropic-adapter.ts` 命中（注释存在）
- 单测：`npm test -- anthropic-adapter` 退出 0，含「messages 里有 system 项时 SDK wire body 不含 system role」用例
- `npm run typecheck` 退出 0

**Commit:** 1 commit = this 1 task
**[blocks:]** T1（T2 改动的类型系统依赖 T1 扩 role）
**Status:** [ ] pending

---

### T3. `[implementation]` TUI system 分支（学习 OpenHarness 视觉语义，独立实现）

**Affects:**

- `src/tui/message-blocks.tsx:121-132` — `MessageBlocks` 加 `if (message.role === "system")` 分支，warning 色 + 图标 + 固定文案 `Interrupted by user.`，**不走** Markdown/thinking 逻辑
- 沿用仓库现有色板（`dim`/`warning` 等已有常量）；无新增依赖
- 单测：渲染 system 消息断言文本/warning/图标，不走 Markdown 路径

**Acceptance (binary):**

- `grep -nE 'role === "system"' src/tui/message-blocks.tsx` 命中
- 单测：`npm test -- message-blocks` 退出 0，含 `role="system"` 渲染分支用例（断言文本 `Interrupted by user.` + warning 色 + 不调 Markdown 渲染器）
- `npm run typecheck` 退出 0

**Commit:** 1 commit = this 1 task
**[blocks:]** T1
**Status:** [ ] pending

---

### T4. `[implementation]` abort 时序 + 统一 append 接线

**Affects:**

- `src/session-api/hub.ts` 或 `src/harness/loop-engine.ts`（按现有架构选合适入口）— abort signal 回调内 append system 消息到 `LoopState.messages`
- REPL（`src/cli/chat-session.ts`）与 TUI（`src/tui/app.tsx`）的 abort signal **不**各自处理 append——仅发 signal，append 统一在 hub/loop 层
- 边界：`system` 消息不算 turn——hub/checkpoint 已按 `role === "user"` 切片（`hub.ts:172,211` / `checkpoint.ts:31,60-76`），无需改切片逻辑
- 单测：abort 触发后 `messages` 数组末尾追加 `{role:"system", content:[{type:"text", text:"Interrupted by user."}]}`，且 provider 边界（T2）过滤后 SDK wire 不含 system

**Acceptance (binary):**

- `grep -nE 'role: "system"' src/session-api/hub.ts src/harness/loop-engine.ts` 至少 1 命中（append 接线点）
- 单测：`npm test -- abort append system` 退出 0，含「Ctrl+C abort → messages 末尾追加 system 项 → buildMessageParams 后 wire 不含 system」全链路用例
- `npm run typecheck` 退出 0

**Commit:** 1 commit = this 1 task
**[blocks:]** T1, T2
**Status:** [ ] pending

---

### T5. `[implementation]` real-LLM e2e 端到端验证

**Affects:**

- `archive/tests-real-llm/` 新增 e2e（按 `.claude/rules/test.md` LLM-touching 改动须配真实接通模型）：装配 `createRealAnthropicAdapter`（≥1 多 turn + ≥1 真实 tool_call），验证 Ctrl+C 打断后：
  1. session file 持久化的 `messages` 末尾含 `role:"system"` 项
  2. 加载 v4 session file 后 `system` 项仍在且 rewind 锚点正确
  3. SDK wire body **不**含 `role:"system"`（断言 provider input 边界守门）
  4. 缺 key → 显式 skip + Not run（不得删测试或 stub 替身）
- 加 `npm run probe:interrupt-transcript` smoke 脚本（同 `scripts/i9-*-smoke.ts` 模式，缺 key 退出 1）

**Acceptance (binary):**

- `ls archive/tests-real-llm/` 含新增 e2e 文件
- `npm run probe:interrupt-transcript` 退出码：本地有 key → 0；缺 key → 1（按仓库 smoke 约定）
- `npm run test:real-llm -- <new-e2e-name>` 在有 key 时退出 0
- 真实模型 e2e 截图/transcript 收录进 handoff 报告（按 `.claude/rules/test.md` "完成 = 实测过" 硬要求）

**Commit:** 1 commit = this 1 task
**[blocks:]** T1, T2, T3, T4
**Status:** [ ] pending

---

## Cross-references

- **Wayfinder map:** #383 已 cleared（R1/G1/G2/G3/G4 全闭，Decisions-so-far 索引完整）
- **Per-ticket loop (ADR-0012):** 每个 `[implementation]` bullet 走 tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Architecture gate:** 5 个改动点全部 additive / 单点守门，无需走 ACR（无新 bounded context、无跨模块重构、无 schema 破坏性变更）
- **Affected S1-S6 skills:**
  - S2 (defensive-contract)：T1/T2/T4 单测覆盖 role 校验、wire 过滤、abort append 边界
  - S6 (minimal-change)：每条 bullet = 1 commit，T1-T5 串行落地，无 refactor 混入
- **Parallelization surface:** T2 与 T3 可并行（不同文件、无共享状态，但 commit 顺序因 PR 串行展示标 [parallel]）；T4 必在 T1+T2 之后；T5 必最后
- **Out of scope（重申）:** `/continue` 续跑（独立图，schema v4 不堵死 resume 锚定）；interruptReason 三类的 runtime 语义改动（loop 层已存在，schema 不新增字段）

## Verification (writing-plans 验收 4 项)

1. `cat plans/383-b2-interrupt-transcript.md | grep -E "^\s*[0-9]+\."` — tracer-bullet 列表存在（5 条）
2. `git log --oneline | head -5` — 落地后应有 5 个 commit 与 5 条 bullet 对应
3. `git diff --stat HEAD~5..HEAD` — 每条 commit diff scope 与 bullet 的 affects 行匹配
4. 报告含 `成功 = plan has 5 tracer bullets, each with binary acceptance + [implementation] tag`

## Handoff

plan 已落到 `plans/383-b2-interrupt-transcript.md`。执行方式：5 个 commit 串行在 1 个 PR 落地，按 T1 → (T2 ∥ T3) → T4 → T5 顺序。每 commit 前跑 ADR-0012 per-ticket loop。
