# Plan: compress-trigger-gate

**Goal:** 修正手动 `/compact` 与自动 proactive compact 的触发判据，让 token 判据统一接管两条路径的 gate；条数守门失败时降级到 full summary 而不是 no-op；UI 文案按真实原因分类。

**Approach:** 在 `src/harness/compress/index.ts` 引入一个统一判据函数 `evaluateCompactTrigger(messages, { contextWindow, threshold }) -> { action, reason }`，手动与自动两条路径都先经过它，再决定走窗口压缩 / full summary / noop；reason 字段一路透传到 TUI / bridge / Web。**不动 `compactMessages` 实现本体**（ADR-0013 D3：proactive/reactive 复用同一逻辑），不动 `estimate.ts` 与 token 真值契约（ADR-0008 D6）。

**Spec / ADR 引用:**

- `docs/adr/0013-reactive-compact-prompt-too-long-fallback.md` — reactive 兜底已落地，每 run 限 1 次，本 plan 不动
- `docs/adr/0008-token-accounting-usage-placement.md` — D6: chars/N 估算只供压缩决策；estimate 不进核算 / 显示
- `docs/adr/0006-tool-output-capping-hard-truncate-20000.md` — 单条撑爆轴正交于本 plan
- `docs/CONTEXT.md` — append-only messages / usage token accounting / taskFocus（自动模式无 taskFocus）
- 业界对照：`docs/harness-report/` 调研 + OpenHarness `compactMessages` / Cursor `/summarize` / Continue `compaction.ts`（Pattern C + D 已落地，仅补触发层）

**ACR verdict:** 5 行全 `N/A with reason`（本 plan 是已有模块的触发判据修正，不动 context 边界 / 不引入新公开 API / 不新增错误分支 / 不增加复杂度 / 一对一修复）

- bounded-context-guardian: N/A — 不动 module 边界（仍 `session-api` + `harness/compress` + `tui`）
- defensive-contract-validator: N/A — 不引入新公开 API；既有 `compactSession` / `shouldAutoCompact` 行为调整是契约内收敛
- error-handling-enforcer: N/A — 不新增 try/catch；reason 字段是 enum 分支不是错误
- complexity-anti-drift: N/A — 每个函数 ~+10 行；不增分支
- minimal-change-verifier: N/A — 1 commit = 1 bullet；总改动 <120 行；不改 lockfile

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → 1 commit on ticket branch

**Tracker:** GitHub issues（main path），需要时按 `references/tracker.md` 一票一 bullet 拉 blocking edges。

---

## 待写入（persist 阶段调 domain-modeling）

- `docs/CONTEXT.md` 新增术语 **`compact reason`**：触发判据返回的分类标识，取值 `below_token_threshold` | `messages_too_few` | `windowed` | `full_summary`，单源 `src/harness/compress/index.ts:evaluateCompactTrigger()`。理由：当前 UI 文案与判据不匹配的 UX bug 需要 SSOT 术语锚定。
- `docs/CONTEXT.md` 现有 **auto-compact** 概念尚无定义；本 plan 顺带补一条 **`auto-compact token gate`** = proactive compact 在每轮 step 前的 token 阈值判据，关 `contextWindow − MAX_OUTPUT_TOKENS_FOR_SUMMARY − AUTOCOMPACT_BUFFER_TOKENS`（值见 `src/harness/compress/threshold.ts`），与手动 `/compact` 共享同一函数。
- 无 ADR 冲突需 reopen（ADR-0013 D3「proactive/reactive 复用同一逻辑」= 不动 `compactMessages` 本体；ADR-0008 D6「estimate 只供压缩决策」= 本 plan 仅在 trigger 决策处使用 estimate，不进 trace/usage）。

---

## Tasks（ordered by dependency）

1. **`evaluateCompactTrigger` 统一判据 API** — tag: `[decision]`（同时含 implementation，因契约落地才能让后续 bullet 编译）
   - **Inherits:** ADR-0008 D6（estimate 仅供压缩决策）；ADR-0013 D3（proactive/reactive 共用 compactMessages，本 plan 不引入新压缩路径，只新增 fallback 触发）
   - **Surface:** `src/harness/compress/index.ts`（既有 `shouldAutoCompact` 同文件）
   - **Acceptance:**
     - 新函数 `evaluateCompactTrigger(messages, { contextWindow, threshold })` 返回 discriminated union：`{ action: 'compact_via_window', reason: 'windowed' }` / `{ action: 'compact_via_full_summary', reason: 'messages_too_few' }` / `{ action: 'noop', reason: 'below_token_threshold' }`
     - 既有 `shouldAutoCompact` 改名为内部 helper 或保留导出并 `evaluateCompactTrigger` 内部委派（不删公开函数，保留外部调用方）
     - 新增 `tests/harness/compress/trigger.test.ts`：3 个 case（token 超 + 条数超 → windowed；token 超 + 条数 ≤ 6 → full_summary；token 未超 → noop）
     - 既有 `tests/harness/compress/integration.test.ts` + `tests/harness/loop-engine.test.ts` 继续全绿
   - Status: [ ] pending
   - blocks: T2, T3, T4

2. **`hub.compactSession` 接入 token-gate + reason 透传** — tag: `[implementation]`
   - **Inherits:** T1（`evaluateCompactTrigger` API）；CONTEXT.md append-only messages（结果回写 store 不动既有 session 形态）
   - **Surface:** `src/session-api/hub.ts`（既有 `compactSession` 方法）
   - **Acceptance:**
     - `hub.compactSession()` 返回值新增 `reason: CompactReason` 字段（4 选 1）
     - token 未达阈值时显式 `reason: 'below_token_threshold'` 并直接 return，不调 `splitForCompaction`
     - token 已达但 `splitForCompaction` 返回 undefined 时调 full summary 路径（复用 `runFullCompact`），成功后 `reason: 'full_summary'`；仍失败时 `reason: 'messages_too_few'` + `compacted:false`
     - `tests/session-api/_compact-integration.test.ts` 新增 3 case：fresh session（消息 ≤ 6 + token 未达）→ `reason:below_token_threshold`；messages=5 + 灌 50k chars → `reason:full_summary`；full summary 抛错 → `reason:messages_too_few` 且 `compacted:false`
     - 既有 `tests/session-api/hub-taskfocus-compact.test.ts:764-814` + `tests/session-api/hub.test.ts` 全绿
   - Status: [ ] pending
   - blocks: T4
   - parallel with: T3

3. **`loop-engine` proactive compact 接入 token-gate + full-summary fallback** — tag: `[implementation]`
   - **Inherits:** T1（API）；ADR-0013 D3（复用 `compactMessages`，不引入新压缩实现）；ADR-0013 D1（reactive 路径不动，每 run 限 1 次契约保留）
   - **Surface:** `src/harness/loop-engine.ts:1522-1554`（既有 proactive 触发块）
   - **Acceptance:**
     - 既有 `state.turnCount > lastCompactTurn` + `shouldAutoCompact` 双重 gate 替换为单一 `evaluateCompactTrigger(state.messages, ...)`
     - 当返回 `action: 'compact_via_window'` → 走既有 `applyCompactAttachment`（行为不变）
     - 当返回 `action: 'compact_via_full_summary'` → 调 `runFullCompact`（既有 reactive 路径函数）生成 summary 后用 `buildCompactedMessages` 重建 messages，命中与窗口压缩同一 boundaryAttachment 注入点
     - `lastCompactTurn` 在**任一** compact 成功后更新（不再因 splitForCompaction no-op 死循环）
     - 新增 `tests/harness/loop-engine.test.ts` 用例：「state.messages.length=5 + 高 token 估算」连续 2 轮，第二轮必须触发 full summary 而非死循环 no-op
     - 既有 `tests/harness/loop-engine.test.ts:2084,2150`（reactive 12 条消息路径）全绿
   - Status: [ ] pending
   - blocks: T5（partial — T5 中 loop-engine 用例依赖本 bullet）
   - parallel with: T2

4. **TUI / bridge / Web 文案按 reason 分支 + reason 透传** — tag: `[implementation]`
   - **Inherits:** T2（`reason` 字段已上线）；CONTEXT.md chat REPL / product SPA（双端文案同步）
   - **Surface:** `src/tui/app.tsx:1522-1525`、`src/tui/hub-bridge.ts:239-258`、`web/src/hooks/use-chat-compact.ts:28`
   - **Acceptance:**
     - TUI 文案：`below_token_threshold` → 「当前 token 未达压缩阈值（{used}/{threshold}），无需压缩。」；`full_summary` → 「已通过结构化摘要压缩上下文（保留 {kept} 条尾部 + 摘要）。」；`messages_too_few` → 「消息条数过少，无法做窗口压缩，且摘要失败 — 上下文保持原样。」；`windowed` → 既有「已压缩上下文（保留尾部，裁剪早期消息）。」
     - `hub-bridge.ts` 在 `compacted` 旁透传 `reason: string`（plain string，不引新 enum 防止 web 端耦合）
     - `use-chat-compact.ts` hook 文案同 TUI 文案 4 分支
     - 新增 `tests/tui/app-compact.test.ts`（若不存在则新建）：4 case 覆盖 reason 文案映射
     - 既有 manual / e2e TUI 路径全绿
   - Status: [ ] pending
   - blocks: T5

5. **集成测试 + 文档收尾** — tag: `[implementation]`
   - **Inherits:** T2, T3, T4 全部 commit 落地
   - **Surface:** `tests/harness/compress/integration.test.ts`（已有 24KB 集成测试）、`tests/session-api/_compact-integration.test.ts`
   - **Acceptance:**
     - `integration.test.ts` 新增 end-to-end 场景：「messages ≤ 6 + 估 token 超阈值」走过完整 loop-engine 一轮 → 断言 `reason:full_summary` + boundaryAttachment 注入 + tool-pair 守门不变 + `lastCompactTurn` 已更新
     - `_compact-integration.test.ts` 新增「fresh conversation 上手动 /compact」覆盖 typed-error catch 契约（CONTEXT.md 「fresh-session 与已存在 session」区分）
     - `docs/STATUS.md` §6 文档索引追加指向本 plan（commit 完成后归档至 `docs/archive/025-.../plans/`）
     - `npm test` 全绿（既有 stub-vitest 全量 + harness/compress 路径）
   - Status: [ ] pending

---

## 切片理由

按 writing-plans skill 的 headroom test：每个 bullet 锁定 slice 形状，不锁实现细节。例如 T2 的实现者可以选择把 token-gate 放在 `compactSession` 开头、或者新抽一个私有 helper；T3 可以把 fallback 写成单独的 `runFullCompactInline(state, deps)` 函数，也可以内联在 loop-engine。两个实现都应通过 Acceptance。

依赖图：

```
T1 (evaluateCompactTrigger API)
    │
    ├──> T2 (hub.compactSession)  ──┐
    │                               ├──> T4 (UI 文案)
    └──> T3 (loop-engine fallback) ┘
                                    │
                                    └──> T5 (集成测试)
```

T2 与 T3 完全独立（不同模块、不同测试），可并行执行（同 PR 不同文件，无冲突）。

## 不在 scope（明确排除）

- **`/compact` 调用缓存 prefix 复用**（Claude Code `tengu_compact_cache_prefix`）— 远期，需配合 IKCap cache 层评估，本 plan 不动
- **`PreCompact` hook**（Claude Code 自定义摘要指令）— iknow 已有 hook 系统（#126 / #406），但 compact 触发前的 hook 未设计；属另一张 plan
- **`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 风格的动态阈值覆盖**— `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` 已存在（`src/config/env.ts:572-588`），不动
- **microcompact（tool result 早裁剪）** — 既有 `executor truncation authority`（ADR-0006）已在 20000 字符层兜底，不重复
- **服务端压缩通道（Codex `POST /v1/responses/compact` 范式）** — 不适用本地 CLI
- **自动压缩 P50/P90 时延优化（Aider double-buffer 范式）** — 远期；本 plan 仅修触发判据
- **sub-agent compact 复用** — `src/harness/subagent/worker.ts:370-372` 已有注入点，本 plan 不动

## 反模式防御

- ❌ 改 `compactMessages` / `splitForCompaction` / `preserveToolPairs` 的实现本体 — ADR-0013 D3 锁定
- ❌ 让 estimate 进 `LlmCallRecord` / `RunResult.lastUsage` — ADR-0008 D6 锁定
- ❌ 移除 `shouldAutoCompact` 公开导出 — 外部调用方未知，先委派保留
- ❌ 引入新压缩策略（basic/agentic/overflow_recovery 三模） — 单路径简化，远期另开 plan
- ❌ 把 reason 字段做强类型 enum 透传到 web — web 与 tui 走 plain string 解耦
- ❌ 在 reactive 路径加额外逻辑 — ADR-0013 D2「每 run 限 1 次」契约保留

## 完成定义

5 个 bullet 全部 commit 落地 + `npm test` 全绿 + code-review 双轴（spec + standards）通过 + `arthurpower:verification-before-completion` 实测一次（用 `mcp__aiterm__pty_*` 起 TUI 真实会话跑 3 个场景：消息 ≤ 6 + 低 token / 消息 ≤ 6 + 高 token / 消息 12 + 中 token） + 本 plan 归档到 `docs/archive/025-retire-completed-specs-and-plans/plans/`。
