# Plan: Harness 真实接入 Anthropic Adapter + 最小演示工具（019）

> **Goal**: foundation 端补上真实 `Anthropic` SDK 绑定 + 最小演示工具（`echo` + `get_time`），跑通真实流量下多 step 闭环（smoke 落 `docs/handoff/i9-smoke/`），为 020 CLI 切到 harness 提供可注入的真实 adapter。
>
> **Architecture**: 在 `src/harness/model-adapter/anthropic-adapter.ts` 同文件新增 `createRealAnthropicAdapter` 工厂（dep injection 接收 `Anthropic` client；`messages.create({ signal })` 调真实 SDK + `interpretMessage` 解释响应）；在 `src/harness/stubs/demo-tools.ts` 新增 `createEchoTool` + `createGetTimeTool`（真实可执行、非业务演示）；在 `scripts/i9-real-anthropic-adapter-smoke.ts` 新增 tsx 独立 smoke（沿 I4 惯例落 `docs/handoff/i9-smoke/`）。离线 `createAnthropicAdapter` 零改，016/017 测试零回归。真实失败回流到后续票（#54 raceModel abort + 真实失败回流占位）不修。
>
> **Tech Stack**: `@anthropic-ai/sdk@^0.115.0`（runtime，已在 `package.json:43`）+ TypeScript strict ESM + Node ≥20 + Vitest + ajv strict（registry 复用）+ `AbortSignal.any`（Node ≥20 内建）。
>
> **Tracker**: GitHub issues（`ready-for-agent` label）— gh CLI 可用（main path）
>
> **Spec link**: none — 走 gh-22 skip 路径，决策收口在 #46 Resolution（Q1–Q5 五题 + 最终 Resolution 评论，2026-07-29 closed）已含 Problem / Solution / Implementation Decisions / Testing Decisions / Out of Scope 五段
>
> **Base branch**: `worktree-wayfinder-gh-collab-adapt`（与 #46 Resolution / #54 (#023) followup 同源；实施时由 per-ticket loop 建 sub-branch）
>
> **依赖**: #46 (#019) closed (2026-07-29) + #54 (#023 engine-timeout HTTP 未取消) open 作为并行 followup（不在本 plan 实施；本 plan 不修改 017 `raceModel`）

---

## Section 1 — Context-Loop Pre-Check

- `docs/CONTEXT.md` 已读（隐含通过 #46 Resolution 引用 014 / 015 / 016 / 017 既有术语：Loop Engine / append-only messages / turnCount / LoopTrace / StopReason / ToolExecutionResult / Registry / Executor / ModelAdapter / LoopAdapter / stub model+tool / `interpretMessage` / `encodeToolResults`）。
- `docs/adr/` 为空：本 plan 无 in-scope ADR。决策契约来源 = 014/015/016/017 ticket + 019 (#46) Q1–Q5 Resolution。
- 017 已有 `tests/harness/public-exports.test.ts` 的 Gate B 禁词表扫描（`retry / checkpoint / tokenusage / costusd / httpstatus / requestid / otel / span / metric / withresolvers`）覆盖 `src/harness/` 整树 .ts -- 本 plan 真实 adapter 写入同目录，自动被扫描。
- 无 ADR 矛盾需标注。

## Section 2 — ACR 5-Verdict Block（自评，写入 plan 文件）

```
bounded-context-guardian: yes — 变更限于 src/harness/model-adapter/anthropic-adapter.ts（同文件新增 createRealAnthropicAdapter，复用 interpretMessage/encodeUserText/encodeToolResults 共享纯函数）+ src/harness/stubs/demo-tools.ts（新增单文件）+ src/harness/index.ts（多 export 3 个工厂）+ scripts/i9-real-anthropic-adapter-smoke.ts（新增，不进 src/）；src/harness/ 能力切分不变。
defensive-contract-validator: yes — demo 工具 schema 都加 additionalProperties:false（守 validation_failed 回环）；real adapter 接收注入 client 即可注入 fake client 单测 signal 转发 + 错误分类（Q5.4 决议：单测沿用离线 adapter 驱动 interpretMessage + engine S12–S17，真实 SDK 只在 e2e smoke 出现）；smoke 7 条断言（Q5.2）守真实多步闭环。
error-handling-enforcer: yes — 不新增错误类（沿用 ProtocolError / ToolExecutionError / RegistryConstructionError 三类）；real adapter 抛 SDK APIError 时由 raceModel 现有 catch 路由（017 S12–S17 已绿；engine 错误路由不动）；demo 工具 handler 不抛（纯函数）。
complexity-anti-drift: yes — real adapter 工厂 ≤ 50 行（messages.create 调 + interpretMessage 复用）；demo-tools 单文件 ~40 行；stubs/demo-tools.ts 与 anthropic-adapter.ts 总行数仍在 file ≤ 500 soft trigger 内（anthropic-adapter.ts 当前 243 行 + 真实工厂 ~50 行 = ~290 行）；cyclomatic nesting ≤ 4。
minimal-change-verifier: yes — 无新依赖（@anthropic-ai/sdk 已是 runtime dep）；diff 限于 src/harness/ 自治范围 + scripts/ smoke + index.ts export；不动 host 层（src/cli* / src/session-api/ / src/interaction/ / web/）；不动 014/015/016/017 冻结契约；1 commit = 1 tracer bullet。
```

## Section 3 — Tracer Bullets（依赖序）

---

### T1. `[decision]` Real adapter 共享纯函数提取 + createRealAnthropicAdapter 工厂接口

- **背景**: Q1/Q3 决议新增 `createRealAnthropicAdapter` 独立工厂（脱机 adapter 不动），同文件 `anthropic-adapter.ts`。需要先决 `interpretMessage` / `encodeUserText` / `encodeToolResults` 是 file-local 私有（anthropic-adapter.ts 末 export）还是 export 给 real factory 复用。最简解：把三个函数从 file-local `function` 改为 `export function`（同文件 export），real factory 在同文件 import 复用；零文件扩张，零依赖调整。
- **决策**:
  - `interpretMessage` / `encodeUserText` / `encodeToolResults` 改为 `export function`（同文件内 export；其他文件不依赖；最小化 surface）
  - `createRealAnthropicAdapter(opts: RealAnthropicAdapterOptions): AnthropicAdapter` 在同文件新增；`RealAdapterOptions` 含 `client: Anthropic`（注入）+ `model: string` + `maxTokens: number` + 可选 `defaultMaxTokens?: number`（用于 SDK `max_tokens` 默认值）
  - 工厂内部 `step(state, request, signal?)` 调 `client.messages.create({ model, max_tokens, messages, tools, signal })` + `interpretMessage(sdkResp)`
  - 不动离线 `createAnthropicAdapter` / `AnthropicAdapterOptions` / `AnthropicAdapter` 接口
- **Affects**: 无代码变更（纯决策记录；T2 实施时引用）
- **Acceptance**: 决策写入本 plan，T2 实施时引用。□

---

### T2. `[implementation]` 真实 Anthropic Adapter：createRealAnthropicAdapter 工厂 + signal 转发

- **Affects**:
  - `src/harness/model-adapter/anthropic-adapter.ts` —
    - `interpretMessage` / `encodeUserText` / `encodeToolResults` 改 `export function`（T1 决策）
    - 新增 `export interface RealAnthropicAdapterOptions { readonly client: Anthropic; readonly model: string; readonly maxTokens: number }`
    - 新增 `export function createRealAnthropicAdapter(opts: RealAnthropicAdapterOptions): AnthropicAdapter`
    - 工厂内 `step(state, request, signal?)`：构造 `messages.create` 参数对象（`{ model, max_tokens: opts.maxTokens, messages: state.messages, tools: request.tools, signal }`）；`await client.messages.create(params)` 拿 `SdkMessage`；返回 `interpretMessage(sdkResp)`；任何 SDK 抛错（`APIError` / `AbortError`）让 raceModel 现有 catch 路由（不 catch，让上层处理）
  - `src/harness/index.ts` — 多 export `createRealAnthropicAdapter` + `RealAnthropicAdapterOptions`
- **Acceptance**:
  - 现有 `createAnthropicAdapter` 9 tests 零回归（`tests/harness/model-adapter/anthropic-adapter.test.ts`）□
  - 现有 `tests/harness/public-exports.test.ts` 公共出口测试过（多 export 不破坏 `createAnthropicAdapter` 等现有断言）□
  - 现有 Gate B 禁词表扫描过（真实 adapter 文件不引入禁词）□
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0（`tests/harness/` 全过，含离线 9 tests + 公共出口 + Gate B）□
  - `src/harness/model-adapter/anthropic-adapter.ts` 总行数 ≤ 350（290 soft cap）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T3, T6]`

**实施要点**:

- `messages.create` 第二个参是 `MessageCreateParams`；`tools` 字段在 SDK 类型是 `Tool[] | undefined`；request.tools 已是 `unknown`（LoopAdapter 签名），需要 narrow 一下但不强校验（Registry 已保证）
- SDK `messages.create` 自动接 `signal`（SDK 0.115 行为已确认）；不需要把 signal 透传到 client 构造期
- 不在 factory 内部 new `Anthropic`（Q1c 决议：dep injection）
- 真实 adapter 不带 `responses` 队列（offline queue 概念不适用真实 IO）
- 不处理 `stream: true`（017 A1 冻为 `stream: false`；真实 adapter 同样 stream:false 拿非流式 SdkMessage）

---

### T3. `[implementation]` Demo 工具：createEchoTool + createGetTimeTool

- **Affects**:
  - `src/harness/stubs/demo-tools.ts` — **新增**：导出 `createEchoTool()` / `createGetTimeTool()` 两个工厂，返回 `ToolDef`
    - `createEchoTool()`:
      - `name: "echo"`, `description: "echo back the input text"`
      - `inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }`
      - `handler: async (input) => { const t = (input as { text?: unknown }).text; if (typeof t !== "string") throw new ToolExecutionError("echo: text must be string"); return t; }`（安全断言：handler input 已被 ajv validator 通过，但 TS 层 `unknown` 需 narrow）
    - `createGetTimeTool()`:
      - `name: "get_time"`, `description: "return current ISO timestamp"`
      - `inputSchema: { type: "object", additionalProperties: false }`
      - `handler: async () => new Date().toISOString()`
  - `src/harness/index.ts` — 多 export `createEchoTool` + `createGetTimeTool`
  - `tests/harness/stubs/demo-tools.test.ts` — **新增**：
    - `createEchoTool` 注册到 `createRegistry` 不抛（schema 编译通过）
    - echo handler 调 `handler({ text: "hi" })` 返 `"hi"`
    - echo handler 调 `handler({ text: "hi", extra: 1 } as any)` 抛（ajv 拒绝，由 Executor 包装为 `validation_failed`，不直接调 handler）
    - `createGetTimeTool` 注册通过；handler 返 ISO 字符串（`/^\d{4}-\d{2}-\d{2}T/` 正则匹配）
    - get_time 拒绝 `{ tz: "x" }` 传（Executor 走 `validation_failed`）
- **Acceptance**:
  - 现有 `tests/harness/stubs/stub.test.ts` 零回归 □
  - demo-tools 通过 Registry 构造期校验（`createRegistry([createEchoTool(), createGetTimeTool()])` 不抛）□
  - echo handler 返字符串（输入 `hi` 返 `hi`）□
  - get_time handler 返 ISO 字符串 □
  - `additionalProperties: false` 拒绝额外字段（Echo 加 `extra` 走 Executor `validation_failed`）□
  - `npm run typecheck` + `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T4]`
- `[parallel]` 与 T2（不同文件，T2 写 adapter、T3 写 stubs/demo-tools.ts）

**实施要点**:

- handler 内部对 input 做 narrow 断言是必须的（TS 层 `input: unknown`），抛 `ToolExecutionError` 由 executor `sanitizeFailure` 净化为 `execution_failed`
- handler 返 string/executor 返 `payload: [{ type: "text", text: <iso> }]`（015 `safeContent` 已有路径，零改 executor）
- demo 工具不接 `ctx.signal`（纯函数 + 1 行 `Date.toISOString`），不参与 S17 守门（S17 vehicle 仍是 `stub-signal-tool`）
- 不 export demo 工具**注册后的** `Registry`（仅 export 工厂；装配由 smoke 自行调 `createRegistry([createEchoTool(), createGetTimeTool()])`）
- demo 工具不存状态（`ToolDef` 已是 immutable，无可变实例字段）

---

### T4. `[implementation]` Smoke 脚本：i9-real-anthropic-adapter-smoke.ts

- **Affects**:
  - `scripts/i9-real-anthropic-adapter-smoke.ts` — **新增**：
    - 启动时 host-layer guard（读自身源码字符串，扫禁词 `["src/cli", "src/session-api", "src/interaction", "web/"]`，命中即 throw + stderr 提示 + exit 1）
    - `loadIknowEnv()` 读 baseURL / apiKey / model；缺 apiKey → `console.error("set NINE_ROUTER_API_KEY or ANTHROPIC_API_KEY")` + `process.exitCode = 1` + return
    - `new Anthropic({ apiKey, baseURL })` 注入 `createRealAnthropicAdapter({ client, model, maxTokens: 1024 })`
    - `createRegistry([createEchoTool(), createGetTimeTool()])` + `createExecutor(registry)` + `createLoopEngine({ adapter: realAdapter, executor, registry, maxTurns: 6 })`
    - 用户文本 `"echo 'hello harness' 然后告诉我当前时间"`
    - Q5.2 7 条断言：① `stopReason === "completed"` ② `turnCount >= 2` ③ `trace.turns.length >= 2` ④ 至少一次 `toolCalls[].kind === "ok"` ⑤ `finalText` 非空 ⑥ `echo` 与 `get_time` 都至少被调一次 ⑦ 每个 turn `supplierStop !== undefined`
    - 成功路径：stdout `result=pass key_env=... model=... turns=N stop_reason=completed tools=echo,get_time durationMs=...` + 写 `docs/handoff/i9-smoke/real-anthropic-adapter.{json,md}` + exit 0
    - 失败路径：stdout 打 trace 完整 JSON + stderr 指向 md + 写 fail 文件 + exit 1
  - `docs/handoff/i9-smoke/` — **新增目录**（smoke 跑通后落文件；现有 .gitignore `docs/handoff/*` + `!docs/handoff/*.md` 已自动放行 .md / .json 在子目录被 track，**不动 .gitignore**）
  - 不动 `.gitignore`（I4 已立先例：`docs/handoff/i4-smoke/llm.json` 被 track，无需加例外）
- **Acceptance**:
  - `node -e "require('fs').readFileSync('scripts/i9-real-anthropic-adapter-smoke.ts', 'utf8')"` 不抛（脚本能跑）
  - `npx tsx scripts/i9-real-anthropic-adapter-smoke.ts` 在无 apiKey 时 exit 1 + stderr "set NINE_ROUTER_API_KEY or ANTHROPIC_API_KEY" □
  - 在有 apiKey + 网关通时 exit 0 + 落 `docs/handoff/i9-smoke/real-anthropic-adapter.json`（含 result=pass, timestamp, model, baseUrl, turns, stopReason, toolNames, finalText_excerpt, durationMs）+ 落 `.md`（人读表格）□
  - 在有 apiKey + 网关通时跑通 7 条断言（操作员手测一次：smoke 至少跑通一次，符合 019 exit condition "完成 = 跑过 = ground truth"）□
  - 脚本源码不含 `src/cli` / `src/session-api` / `src/interaction` / `web/`（host-layer guard 自检通过）□
  - 失败路径：模拟 apiKey 错时 exit 1 + 落 fail 文件 + 打 trace（手测：注入无效 key 验证一次）□
  - `npm run typecheck` 退出码 0（脚本也走 tsc 编译）□
  - `npm test` 退出码 0（scripts/ 不在 vitest 默认 include 范围，但确认不破）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T5]`
- `[parallel]` 与 T2、T3（T4 写 scripts/，与 src/harness/ 写不同文件；但 T4 依赖 T2/T3 的 export 才能 import）

**实施要点**:

- smoke 跑通不保证单次成功（真实流量有随机性），重跑到过为止（操作员手控）；smoke 设计不引入重试逻辑
- 真实失败回流（如模型偶发撞 maxTurns）不进 smoke 自动 retry，由 `docs/handoff/i9-smoke/*.md` 留档 + 必要时操作员开后续 ticket
- 不写进 `npm test` / `npm run smoke` / `npm scripts`；独立 `npx tsx scripts/i9-real-anthropic-adapter-smoke.ts`
- 写文件用 `mkdirSync(outDir, { recursive: true })` 兜底目录存在
- `.md` 报告格式对齐 `docs/handoff/i4-smoke/llm.md` 风格（"Result: PASS/FAIL" + Check 表格）
- 不在 smoke 内 log 任何 key / baseURL 完整值（baseURL 只截到 host 不带 path）

---

### T5. `[implementation]` 集成验证 + 公共出口 + Gate B 守门回归

- **Affects**:
  - `src/harness/index.ts` — 确认新增 4 个 export (`createRealAnthropicAdapter` / `RealAnthropicAdapterOptions` / `createEchoTool` / `createGetTimeTool`) 全部可见
  - 全量 `npm test` + `npm run typecheck` + `npx tsx scripts/i9-real-anthropic-adapter-smoke.ts`（操作员手测一次，记录 trace 到 `docs/handoff/i9-smoke/`）
  - 代码审查：确认 `src/harness/` 不含条件式修复层（沿 017 Gate B 禁词表）
- **Acceptance**:
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0（现有 016/017 全套 + T2/T3 新增测试全过）□
  - `npx tsx scripts/i9-real-anthropic-adapter-smoke.ts` 跑通一次，`docs/handoff/i9-smoke/real-anthropic-adapter.json` 存在且 `result === "pass"`，`.md` 报告记录 7 条断言全过 □
  - `tests/harness/public-exports.test.ts` 公共出口断言过 + Gate B 禁词表扫描过 □
  - 014 / 015 / 016 / 017 冻结契约零变更（grep `interpretMessage` / `StopReason` / `ToolExecutionResult` / `executeAll` / `raceModel` 等 SSOT 形状未改）□
  - 真实失败回流（若有）已留档到 `docs/handoff/i9-smoke/*.md` notes 段 + 后续 ticket（#54 #023 raceModel abort 是已立 followup；其他失败如需开新 ticket 留待操作员决策）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T2, T3, T4]`

**实施要点**:

- 本 tracer bullet 是"集成 + 真值证据"，不是新代码；只 commit 公共出口最终对齐（如有遗漏 export 补齐）+ smoke 真值证据落档
- 操作员手测 smoke 是 "完成 = 实测过" 必走项（CLAUDE.md 顶上明文）
- 若 smoke 跑出未预料的失败，**不在本 plan 修复**；开后续 ticket 走 #46 boundary "真实失败回流进后续票不修"
- #54 (#023 raceModel abort) 是已立并行 followup，**不在本 plan 范围**；本 plan 不修改 `raceModel`

---

## Dependency Graph

```
T1 [decision]
  │
  ▼
T2 [implementation] ── createRealAnthropicAdapter（src/harness/model-adapter/anthropic-adapter.ts）
  │                                              │
  │ [parallel]                                   │ [parallel]
  ▼                                              ▼
T3 [implementation] ── demo-tools           +  T4 [implementation] ── smoke
   （src/harness/stubs/demo-tools.ts）          （scripts/i9-*.ts）
  │                                              │
  └──────────────────────┬───────────────────────┘
                         ▼
                T5 [implementation] ── 集成验证 + 公共出口 + smoke 真值落档
                [blocks: T2, T3, T4]
```

---

## Cross-references

- **architecture-change-reviewer verdict**: yes per all 5 Core Skills（见 Section 2 ACR 5-verdict block；自评因走 gh-22 skip 路径未跑 `arthurpower:architecture-change-reviewer` 子代理；如操作员要求额外自评，可派 `arthurpower:architecture-change-reviewer-agent` 子代理以正式 ACR verdict 替换 Section 2 自评）
- **affected S1-S6 skills**:
  - S1 bounded-context: 变更限 `src/harness/` + `scripts/` + `docs/handoff/i9-smoke/`，不动 host 层
  - S2 defensive-contract: demo 工具 schema `additionalProperties:false`；smoke 7 条断言守真实多步闭环
  - S3 error-handling: 沿用三类错误（ProtocolError / ToolExecutionError / RegistryConstructionError），不新增
  - S4 test-coverage: T2 沿用离线 9 tests + 公共出口；T3 新增 demo-tools.test.ts（5 测试）；T4 smoke 真值 7 断言
  - S5 complexity-anti-drift: real adapter ≤ 50 行；demo-tools 单文件 ~40 行；file ≤ 350 行 soft cap
  - S6 minimal-change: 无新依赖；diff 限 src/harness/ + scripts/ + index.ts；不动 014/015/016/017 冻结契约；1 commit = 1 bullet
- **parallelization surface**: T2 (adapter) / T3 (demo-tools) / T4 (smoke) 在不同文件，但 T4 依赖 T2/T3 的 export 才能 import，所以 T2/T3/T4 在实施期是串行的（虽然 commit 可并发 push）。T5 必须最后
- **Gantt** (commit order): T1 → T2 → T3 → T4 → T5（每条 commit 独立 branch off `worktree-wayfinder-gh-collab-adapt`）
- **related tickets**:
  - #46 (019) closed 2026-07-29 — 决策收口源
  - #54 (#023 engine-timeout HTTP 未取消) open — 并行 followup，本 plan 不实施
  - #47 (020 CLI 切到 harness) blocked by 019 — 下一张 frontier，本 plan 完成解锁

## Verification Checklist

- [x] Plan has ≥ 3 tracer bullets → **5 bullets** (T1 decision + T2/T3/T4/T5 implementation)
- [x] Each bullet has 1+ binary acceptance criterion → yes
- [x] Each bullet maps to exactly 1 commit → yes
- [x] Bullets ordered by dependency → yes（T1 → T2 → T3/T4 [parallel] → T5）
- [x] Plan lives in `plans/harness-real-anthropic-adapter-and-demo-tool.md` → yes
- [x] ACR 5-verdict block present in Section 2 → yes（自评；gh-22 skip 路径）
- [x] Context-loop pre-check in Section 1 → yes
- [x] Per-ticket loop embedded in each `[implementation]` bullet → yes
- [x] Tracker = GitHub issues (main path, gh CLI available) → ready-for-agent label
- [x] Does NOT touch host layer (src/cli* / src/session-api/ / src/interaction/ / web/) → yes
- [x] Does NOT modify 014/015/016/017 frozen contracts → yes
- [x] Does NOT modify raceModel (017 frozen, #54 followup outside this plan) → yes
- [x] Smoke artifact lands in `docs/handoff/i9-smoke/` per I4 convention (no .gitignore change needed) → yes
