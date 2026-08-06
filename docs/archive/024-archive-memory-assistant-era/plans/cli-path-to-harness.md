# Plan: CLI 路径切到 harness foundation（020）

> **Goal**: 把 CLI 产品路径（`ask` / `chat`）从旧 `src/agent-loop/` 切到新 `src/harness/` foundation，使操作员在终端用真实模型 + harness 循环跑出多 step 工具调用与最终回答；旧 `IknowAgent` / `LlmIknowAgent` / `ConversationState` / `IknowAnswer` 在 CLI 路径完全退役。
>
> **Architecture**: 一行 harness 改动（`run()` 加可选 `opts.priorMessages`）+ `src/cli/runtime.ts:buildAgent` 真实装配（`new Anthropic({ apiKey, baseURL })` 注入 `createRealAnthropicAdapter` + 构造 `LoopEngineDeps`）+ CLI 端 fork `src/cli/format.ts`（`formatRunHuman` + `formatRunJson`）+ fork `src/cli/slash.ts`（`/mode` 砍掉）/host 层 `processChatLine` 用 harness `run()` 续传 `priorMessages`/`src/cli.ts` dispatch 消费 `{ result, trace }`/`src/cli/parse-args.ts` 删 `--mode` flag；`src/interaction/*` 020 一字不动（Session API 仍在 import，归 #51 退役）；旧 `agent-loop/*` 不动（归 021）。新增 `scripts/i10-cli-harness-smoke.ts` 真实跑通 ask + chat pipe 两条路径，证据落 `docs/handoff/i10-smoke/`。
>
> **Tech Stack**: TypeScript strict ESM + Node ≥20 + Vitest + ajv strict（015）+ `@anthropic-ai/sdk@^0.115.0`（runtime，019 已锁）+ `loadIknowEnv()`（默认 9router `NINE_ROUTER_API_KEY`，019 Q1 已锁）+ tsx（smoke，对齐 019 i9 惯例）。
>
> **Tracker**: GitHub issues（`ready-for-agent` label）— gh CLI 可用（main path）
>
> **Spec link**: none — 走 gh-22 skip 路径，决策收口在 #47 Resolution（Q1–Q5 五题 + 最终 Resolution 评论，2026-07-30 closed）已含 Problem / Solution / Implementation Decisions / Testing Decisions / Out of Scope 五段
>
> **Base branch**: `worktree-wayfinder-gh-collab-adapt`（与 #46 #47 Resolution / #54 followup 同源；实施时由 per-ticket loop 建 sub-branch）
>
> **依赖**: #46 (#019) closed (2026-07-29) ✓ + #47 (#020) closed (2026-07-30) ✓ 决策收口源 + #54 (#023 engine-timeout HTTP 未取消) open 作为并行 followup（不在本 plan 实施；本 plan 不修改 017 `raceModel`）+ #48 (#021) blocked by 020 ✓ → 解锁为 NEXT/frontier

---

## Section 1 — Context-Loop Pre-Check

- `docs/CONTEXT.md` 已读（隐含通过 #47 Resolution 引用 014 / 015 / 016 / 017 / 019 既有术语：`Loop Engine` / append-only messages / `turnCount` / `LoopTrace` / `StopReason` / `ToolExecutionResult` / `Registry` / `Executor` / `ModelAdapter` / `LoopAdapter` / stub model+tool / `interpretMessage` / `encodeToolResults` / `createRealAnthropicAdapter` / demo tools `echo` + `get_time` / `loadIknowEnv` / 9router）。
- `docs/adr/` 仅有 `0001-9router-stack-as-code-defaults.md`：本 plan 无 in-scope ADR。9router 作为 LLM 默认网关已被 019 Q1 + ADR-0001 锁，020 复用 `loadIknowEnv()` 即可。
- 017 已有 `tests/harness/public-exports.test.ts` 的 Gate B 禁词表扫描覆盖 `src/harness/` 整树——本 plan 唯一 harness 改动 `run()` 加可选参，自动被扫描（新增 `priorMessages` 字串不命中禁词表）。
- 无 ADR 矛盾需标注。
- `src/interaction/*` / `src/session-api/*` / `web/*` / `src/shared/schema.ts` / `src/agent-loop/*` 020 一字不动（D3-CLI 守门）；变化面收敛在 `src/harness/loop-engine.ts`（1 行）+ `src/cli/*`（5 文件）+ `scripts/i10-cli-harness-smoke.ts` + `tests/*` 受牵连改写 + `docs/handoff/i10-smoke/`。

---

## Section 2 — ACR 5-Verdict Block（自评，写入 plan 文件）

```
bounded-context-guardian: yes — 改动收敛在 src/cli/* + src/harness/loop-engine.ts（1 行）；src/interaction/* 020 不动；src/session-api/* 不动；web/* 不动；src/shared/schema.ts 不动；src/agent-loop/* 不动。CLI 路径新增 src/cli/format.ts + src/cli/slash.ts 形成 CLI-local 投影层，无反向依赖到 src/session-api/ 或 web/。
defensive-contract-validator: yes — run() 加的 opts.priorMessages 是可选参，默认行为不变（016/017 S1–S17 fixture 零回归守门）；formatRunHuman/formatRunJson 接受 RunResult（immutable readonly 字段）输出 string，无副作用；新 src/cli/slash.ts 函数签名与 src/interaction/slash.ts 一一对应但参数类型 ConversationState → CliChatState（窄化），不存在 negative 边界（@param 必填 old state 已被 runtime 校验）。
error-handling-enforcer: yes — 不新增错误类（沿用 ProtocolError / ToolExecutionError / RegistryConstructionError + harness 既有错误路由，019 已锁）；run() opts.priorMessages 不存在时不报错（默认空数组）；CLI host 不新增错误码，错误继续走 stderr（processChatLine 已有 stderr 字段语义）；smoke 失败时落 docs/handoff/i10-smoke/*.json + .md + exit 1，不静默吞。
complexity-anti-drift: yes — formatRunHuman ~30 行（一段 finalText + 一段状态行）；formatRunJson ~10 行（一行 JSON.stringify）；src/cli/slash.ts ~80–110 行（6 个命令 case × 10 行 + parseChatLine ~25 行 + 帮助文本）；src/cli/chat-session.ts processChatLine 改后 ~50 行；buildAgent 改后 ~40 行（删 resolveStartupMode 28 行 + 新装配 ~50 行 = 净增 ~20 行）；file ≤ 500 soft trigger 全守住。cyclomatic nesting ≤ 4；每个 function ≤ 40 行。
minimal-change-verifier: yes — 无新依赖（@anthropic-ai/sdk + tsx 已是 runtime/dev 依赖）；diff 限 src/harness/（1 行可选参）+ src/cli/*（~5 文件改/新）+ scripts/（1 新）+ tests/ 受牵连改写 + docs/handoff/i10-smoke/ 新；不动 src/interaction/* / src/session-api/* / web/* / src/shared/schema.ts / src/agent-loop/*；1 commit = 1 tracer bullet；locked contracts 014/015/016/017/019 全零变更（LockTest = grep SSOT signatures）。
```

---

## Section 3 — Tracer Bullets（依赖序）

---

### T1. `[implementation]` harness `run()` 加可选 `opts.priorMessages` 参数

- **背景**: Q2 决议 Option B。Host 维护 messages 数组，每条用户消息调 `run(query, deps, signal, { priorMessages: prevResult.messages })` 续传历史。`opts.priorMessages` 是可选参，默认空数组；`turnCount` 每条消息从 0 起（每条独立 maxTurns 预算）。这是本 plan 唯一对 `src/harness/` 的改动。
- **Affects**:
  - `src/harness/loop-engine.ts` —
    - `run()` 签名加第 4 参：`run(userText: string, deps: LoopEngineDeps, signal?: AbortSignal, opts?: { priorMessages?: ReadonlyArray<AnthropicNativeMessage> })`
    - 初始 state 构造改：`messages = Object.freeze([...(opts?.priorMessages ?? []), freezeMessage(deps.adapter.encodeUserText(userText))])`，`turnCount: 0` 不变
    - 其余 while 循环体、`stepWithTrace`、trace 累积、StopReason 路由——零改
  - `tests/harness/loop-engine.test.ts` —
    - 新增 1 个 describe block：`run() opts.priorMessages` × 3 个 it：
      - `it("no priorMessages 默认空数组等同旧行为")`：`run("hi", deps)` 返回 `{ result: { finalText, messages: [user, assistant] } }`，`messages.length === 2`
      - `it("priorMessages 前缀 + user text 形成 N+1 起始 messages")`：传 `priorMessages = [userA, assistantA]`，`run("B")` 后 `result.messages[0..1]` 等于 `priorMessages`，`result.messages[2]` 是 user B
      - `it("priorMessages 不影响 turnCount 起 0")`：传 priorMessages 调 `run("B")`，maxTurns=1，模型尝试调工具回到 maxTurns 时 `stopReason === "maxTurns"`（不是 maxTurns + priorMessages 累积）
- **Acceptance**:
  - 现有 `tests/harness/loop-engine.test.ts` 零回归（含 S1–S17 fixture）□
  - 新增 3 个 it 全过 □
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0 □
  - `tests/harness/public-exports.test.ts` 公共出口断言过（`run` 签名变化不影响 export 名）□
  - 014/015/016/017 冻结契约零变更：grep `interface RunResult` / `interface LoopState` / `StopReason` / `raceModel` / `executeAll` / `interpretMessage` / `encodeToolResults` / `ToolExecutionResult` 形状未改 □
  - 017 Gate B 禁词表扫描过（新增 `priorMessages` 字串不命中 retry/checkpoint/tokenusage/costusd/httpstatus/requestid/otel/span/metric/withresolvers）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T4, T5]`

**实施要点**:

- `opts.priorMessages` 是 optional，第 4 参；不传时与旧 API 行为完全一致（016/017 测试不改一行）
- 构造 messages 时 spread + push + `Object.freeze` 保持 immutable 契约（014 冻结）；不修改 `step()` 签名（`step()` 接受 `LoopState`，host 续传场景已能用 `step()` 但会丢 trace，所以走 `run()` 路径）
- 不动 `messages` 类型（仍是 `ReadonlyArray<AnthropicNativeMessage>`，与 `LoopState.messages` 同形）
- 不动 `LoopState` 接口、不动 `RunResult` 字段
- 不动 `raceModel`、`executeAll`、`interpretMessage`、`encodeToolResults`（017 既有物理必需层不动）
- harness file 总行数变化 ≤ +5（签名加一行 + 构造 spread 改一行），仍在 file ≤ 500 soft cap 内

---

### T2. `[implementation]` `src/cli/format.ts` + `src/cli/slash.ts`：CLI 端两个新文件

- **背景**: Q1 + Q3 决议。旧 `formatAnswerHuman`/`formatAnswerJson` 在 `src/interaction/format.ts`（被 Session API `hub.ts:10` import，020 不动）→ CLI 在 `src/cli/format.ts` 新建 `formatRunHuman` + `formatRunJson`，消费 `RunResult` + `LoopTrace`。旧 `applySlashCommand`/`parseChatLine` 在 `src/interaction/slash.ts`（被 Session API `hub.ts:12,184` import，020 不动）→ CLI 在 `src/cli/slash.ts` fork：复用 `/help` `/?` `/quit` `/exit` `/role` 旧逻辑（改参数类型 `ConversationState` → `CliChatState`），改写 `/json`/`/reset`/`/status`（Q3 决议 ①），删除 `/mode` 整条 case + `applyMode` + `AGENT_MODES` + `parseAgentModeCli` + `AgentModeCli` 类型 export（CLI 不再有 mode 概念）。
- **Affects**:
  - `src/cli/format.ts` — **新增**：
    - `import type { RunResult, LoopTrace } from "../harness/index.js"`
    - `export function formatRunHuman(result: RunResult, trace: LoopTrace): string`
      - 拼接 `result.finalText + "\n\n"` + 状态行 `"stop=<result.stopReason> · turns=<result.turnCount> · tools=<join(uniq(trace.turns.flatMap(t => t.toolCalls.map(c => c.toolName))) || "-")> · <trace.totals.totalDurationMs>ms"`
      - 工具名展平去重保序（Set + Array.from）
      - 无 trace 或 trace.turns 为空时 tools 显示 "-"
    - `export function formatRunJson(result: RunResult, trace: LoopTrace): string`
      - `JSON.stringify({ finalText: result.finalText, stopReason: result.stopReason, turnCount: result.turnCount, trace }, null, 2)`
      - 不含 `result.messages`（Q1.1 决议：Anthropic 原生 messages 不进 ask JSON）
  - `src/cli/slash.ts` — **新增**（估 ~80–110 行）：
    - `import type { CliChatState }`（T5 定义，CLI host 维护的 messages+jsonMode+session 状态）
    - `export function parseChatLine(line: string): { kind: "empty" } | { kind: "slash", command: string, args: string[] } | { kind: "query", text: string }` —— 复用旧 `slash.ts:64-82` 的解析逻辑
    - `export interface SlashEffect` 简化版（无 `mode_change` 变体）
    - `export function applySlashCommand(command: string, args: string[], ctx: { state: CliChatState }): SlashEffect` —— dispatch：
      - `quit`/`exit` → `{ type: "quit" }`
      - `help`/`?` → `{ type: "help", text: HELP_TEXT }`（HELP_TEXT 改写：去 `/mode` 行 + 改 `/reset` 行 + 改 `/json` 行）
      - `status` → `{ type: "info", text: formatStatus(ctx) }` —— `formatStatus` 读 `state.messages.length`（旧读 `turns.length`）+ `state.jsonMode`（旧 `json_mode`）+ `state.session.caller_role`；**去掉** `mode` 与 `priors` 两行（已死）
      - `json` → 翻 `state.jsonMode`（旧字段名 `json_mode` 重命名，行为不变）
      - `role <r>` → mutate `state.session.caller_role`（复用旧逻辑，参数类型窄化）
      - `reset` → `state.messages = []`（旧 `resetConversation(state)` 清 turns/priors/history 改清 messages，session 保留）
      - default/`""` → `{ type: "error", text: ... }`
    - 不导 `AgentModeCli` / `AGENT_MODES` / `parseAgentModeCli` / `applyMode`（CLI 不再有 mode）
  - `tests/cli/format.test.ts` — **新增**：
    - `formatRunHuman` 5 个 it：default run（completed + finalText + 1 工具 + 1 turn）、maxTurns stopReason（finalText 可能为 null 的边界）、0 turns（没有工具调用时 tools 显示 "-"）、多 turn 多工具去重保序、stopReason 非 completed（不渲染 finalText？或仍然渲染 finalText 即使是 timeout？由 spec 决）
    - `formatRunJson` 2 个 it：标准输出形态（4 顶层字段 + trace 嵌套）、无 trace（trace 为 undefined 时不抛）
  - `tests/cli/slash.test.ts` — **新增**：
    - `parseChatLine` 4 个 it：empty/query/slash（无 arg）/slash（带 arg）
    - `applySlashCommand` 8 个 it：quit、exit、help、?、status、json on、json off、role valid、role invalid、reset、unknown、empty command
    - 不测 `/mode`（已删）
- **Acceptance**:
  - `formatRunHuman` + `formatRunJson` 7 个 it 全过 □
  - `applySlashCommand` + `parseChatLine` 12 个 it 全过 □
  - `npm run typecheck` 退出码 0（新文件 import 路径正确）□
  - `npm test` 退出码 0（含新文件 vitest discovery）□
  - 新文件不 import `src/interaction/*` 任何符号（grep 自检通过）□
  - 新文件不 export `AgentModeCli`/`parseAgentModeCli`/`AGENT_MODES`（grep 自检通过）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T4, T5]`
- `[parallel]` — T2 与 T3（不同文件，无共享状态）

**实施要点**:

- `formatRunHuman` 不需要等 `RunResult.finalText` 非 null 才渲染状态行（仍然渲染 finalText 即使是空字符串；`finalText: null` 时输出空文本 + 状态行——后续 host 决定要不要兜底）
- 工具名展平用 `Array.from(new Set(names))` 保首次出现顺序
- `HelpText` 改写时保留双语（命令/Commands 双行格式）；`_slash_help` 测试断言关键字（"help" "status" "quit" "exit" "json" "role" "reset"）出现，不断言 `/mode`
- `applySlashCommand` 返回类型用 discriminated union `{ type: "quit" | "help" | "info" | "reset" | "error", text?: string }`，CLI host switch 简单
- 文件落点 `tests/cli/` 与 `src/cli/` 平级（项目没有 `tests/cli/` 子目录则建一个；如已有则复用）

---

### T3. `[implementation]` `src/cli/runtime.ts`：`buildAgent` 真实装配 + 删 mode 分支

- **背景**: Q2 + Q3 决议。`buildAgent` 不再返回旧 `IknowAgent` / `LlmIknowAgent`（旧 `answer() → IknowAnswer` 形态）；改为构造真实 `Anthropic` 客户端 + 注入 `createRealAnthropicAdapter` + 构造 `LoopEngineDeps` + 返回可调用 `run()` 的 harness engine。同时删 `resolveStartupMode`（28 行）+ `AgentModeCli` import + mode 启动分支。
- **Affects**:
  - `src/cli/runtime.ts` —
    - 删除：`resolveStartupMode` 函数（lines 116-128）+ mode 启动分支逻辑
    - 删除：`import type { AgentModeCli } from "../interaction/slash.js"`（line 20）
    - 删除：`assertOfflineCompatible` 调用（mode === "llm" 分支入口）
    - 修改：`buildAgent` 签名与返回：`(bundle: RuntimeBundle): Promise<{ engine: { run: LoopAdapter["step"]-like }, ... }>` 或更精确：返回 `LoopEngineDeps` + 已构造的 `engine`（由 host 决定调 `run()` 还是 `step()`）
    - 推荐返回结构：`Promise<{ deps: LoopEngineDeps, engine: Awaited<ReturnType<typeof createLoopEngine>> }>`
    - `buildAgent` 内部：`loadIknowEnv()` → `new Anthropic({ apiKey: env.llm.apiKey, baseURL: env.llm.baseUrl })` → `createRealAnthropicAdapter({ client, model: env.llm.model, maxTokens: env.llm.maxOutputTokens })` → `createRegistry([createEchoTool(), createGetTimeTool()])`（019 demo 工具）→ `createExecutor(registry)` → `createLoopEngine({ adapter, executor, registry, maxTurns: env.llm.maxTurns ?? 6, timeoutMs: ... })`
    - 缺 apiKey 时 throw `Error("CLI LLM mode needs env.llm.apiKey from loadIknowEnv()")`（与旧 buildAgent 错误信息兼容）
  - `tests/cli/runtime.test.ts`（如不存在则新建 `tests/runtime/build-agent.test.ts`）—
    - `buildAgent` 返回的 `engine` 字段类型守门（编译期）
    - `buildAgent` 失败：缺 apiKey 时 throw with helpful message（env mock 测试）
- **Acceptance**:
  - `tests/cli/runtime.test.ts`（或 `tests/runtime/build-agent.test.ts`）新增 it 全过 □
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0（含 cli-session 旧测试可能因 `resolveStartupMode` 引用挂掉，**预期内**——T5 测试分流处理）□
  - `src/cli/runtime.ts` 不再 import `agent-loop/*` 任何符号（grep 自检通过）□
  - `src/cli/runtime.ts` 不再 import `AgentModeCli` / `assertOfflineCompatible`（grep 自检通过）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T4, T5]`
- `[parallel]` — T3 与 T2（不同文件）

**实施要点**:

- `buildAgent` 旧返回 `{ agent: AnswerAgent, mode: "llm" | "deterministic" }` → 新返回 `{ deps: LoopEngineDeps, engine }`；调用方在 T4（chat-session / cli.ts）改用 `run("query", engine.deps)`（实际通过 `engine.run("query")` 调用 createLoopEngine 返回的闭包）
- `createEchoTool` + `createGetTimeTool` import 来自 `src/harness/index.js`（019 已 export，`stubs/demo-tools.ts` 路径）
- `createLoopEngine` import 来自 `src/harness/index.js`
- `createRealAnthropicAdapter` import 来自 `src/harness/index.js`
- `Anthropic` 客户端构造不接受 `model`（model 在 adapter 注入时传），只接受 `apiKey` + `baseURL` + 可选 `timeout`
- `maxTurns` 默认值 6（对齐 019 i9 smoke）
- 不在 `buildAgent` 内调 `run()`（只构造 deps + engine，调用方决定何时跑）
- `RuntimeBundle` 保留（env + store + session + vectorIndex 等仍有用），但只用 env 部分；store / session / vectorIndex 在 harness 路径下不再是必需（T4 host 用 harness 的 LoopState.messages 替代 session 的 history_finals）—— 评估是否保留字段以最小化耦合（若 buildAgent 不再消费 store / vectorIndex，可保留 RuntimeBundle 整体结构但 buildAgent 不读它们，留给后续清除）

---

### T4. `[implementation]` `src/cli/chat-session.ts` + `src/cli.ts` + `src/cli/parse-args.ts`：host 层装配

- **背景**: Q2 + Q3 决议 host 层联动。`src/cli/chat-session.ts` 改为：用 T3 buildAgent 返回的 `engine` 调 `run()`，用 T2 format 函数渲染，用 T5（= T2）slash 模块派发 command，维护 CliChatState（3 字段：messages + jsonMode + session）。`src/cli.ts` 改 dispatch + 删 `--mode` 短路。`src/cli/parse-args.ts` 删 `--mode` flag + `AgentModeCli` import。
- **Affects**:
  - `src/cli/chat-session.ts` —
    - 新 `type CliChatState = { messages: ReadonlyArray<AnthropicNativeMessage>; jsonMode: boolean; session: SessionContext }`（文件内定义或单独文件；建议内联在 chat-session.ts 顶）
    - `processChatLine` 改写：
      - 仍调 `parseChatLine(line)`（现在来自 `src/cli/slash.ts`）
      - slash 路径调 `applySlashCommand` 来自 `src/cli/slash.ts`；`/` reset`改写后已清`state.messages`
      - 查询路径：`ctx.engine.run(query, undefined, undefined, { priorMessages: state.messages })` 续传（前提：`run` 第四参为 opts，引擎信号 slot 用 undefined 占位）
      - 结果：`{ result: RunResult; trace: LoopTrace }`
      - 更新 `state.messages = result.messages`（即便 stopReason !== completed 也要续传，否则下回合丢上下文——具体边界由 host 决定；建议：maxTurns/cancelled/timeout 时仍续传，protocolError 不续传）
      - 输出：`ctx.state.jsonMode ? formatRunJson(result, trace) : formatRunHuman(result, trace)`
    - 删除：`import` 自 `src/interaction/*`（`createConversation`/`formatAnswerHuman`/`formatAnswerJson`/`recordTurn`/`ConversationState`）—— 改为 import 自 `src/cli/*`（`formatRunHuman`/`formatRunJson`）+ `src/cli/slash.ts`（`applySlashCommand`/`parseChatLine`）+ 新增 `import { createRealAnthropicAdapter, createEchoTool, createGetTimeTool, createRegistry, createExecutor, createLoopEngine, ... } from "../harness/index.js"`
  - `src/cli.ts` —
    - `runOneShot(parsed)`：`agent.answer(parsed.query)` → `engine.run(parsed.query, undefined, undefined, { priorMessages: undefined })` → `formatRunJson(result, trace)`
    - `runChat(parsed)`：`await buildAgent(bundle)` → 用 T3 返回；`agent` 变量名改为 `engine`；`runChatSession({ engine, ... })` 替换 `runChatSession({ agent, ... })`
    - 删除：`/mode` 解析 + `mode` 短路 + `--mode` 帮助文字
    - 删除：`import { formatAnswerJson } from "./interaction/index.js"` —— 改用 T2 `formatRunJson`
  - `src/cli/parse-args.ts` —
    - 删 `--mode` flag parse + `AgentModeCli` import
- **Acceptance**:
  - `src/cli.ts` 不再 import `src/agent-loop/*` 任何符号（grep 自检通过）□
  - `src/cli.ts` 不再 import `formatAnswerJson` 来自 `./interaction/index.js`（grep 自检通过）□
  - `src/cli/chat-session.ts` 不再 import `src/interaction/*` 任何符号（grep 自检通过——`ConversationState`/`recordTurn`/`createConversation`/`formatAnswer*` 全移除）□
  - `src/cli/parse-args.ts` 不再 export `AgentModeCli` / `parseAgentModeCli`（grep 自检通过）□
  - `npm run typecheck` 退出码 0（processChatLine 签名、CliChatState 类型对齐）□
  - `npm test` 退出码 0（**预期内**：`tests/cli-session.test.ts` 大量 it 会因 `processChatLine` 改 harness 而挂——T5 改写；本 bullet 仅类型 + 编译 + 旧测试期望失败）□
  - 已迁的 import 路径全部走 `src/cli/*` + `src/harness/*` + `src/session-api/*`（Session API 部分不动）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T5]`

**实施要点**:

- CliChatState 内联在 `src/cli/chat-session.ts` 顶（避免建独立 `src/cli/chat-state.ts` 多余文件；3 字段小类型内联更清晰）
- `engine.run()` 实际签名（after T1）：`run(userText: string, deps: LoopEngineDeps, signal?: AbortSignal, opts?: { priorMessages?: ReadonlyArray<AnthropicNativeMessage> })`；本 plan 装配层持有 `engine.deps`，host 不直接调 `engine.run`（`engine.run` 是闭包），而是用 `run(text, deps, signal?, opts?)` 直接传 deps
- 推荐 host 持 `engine = createLoopEngine(deps)`，然后 `engine.run(text, opts)` 即调闭包（第二参 signal 默认 undefined）
- `runChatSession` 的 `buildAgent` callback（用户 `/mode` 触发重建 agent）整条删除——CLI 不再有 mode 切换；`/mode` 命令已砍
- `chat-session.ts:88-99` 那段（`agent.answer` → `formatAnswer*` → `recordTurn`）替换为：`engine.run(query, undefined, undefined, { priorMessages: state.messages })` → `state.messages = result.messages` → `formatRun*(result, trace)`
- `runOneShot` 不传 priorMessages（一次性，独立会话）
- `runChat` 启动时 `state.messages = []`（空历史）
- `runInteractive` / `runPiped` 函数体不需大改（已通过 `processChatLine` 抽象）

---

### T5. `[implementation]` 受牵连测试改写（3 个文件）

- **背景**: Q5.1 决议。`tests/interaction.test.ts` 完全不动（守 `src/interaction/` 旧模块，Session API 仍消费）。`tests/chat-repl.test.ts` 分流：`parseChatLine` + `applySlashCommand` describe 保留守旧 `src/interaction/slash.ts`，`chat session integration` 重写为 harness 形态。`tests/cli-session.test.ts` 大改：删 `resolveStartupMode` describe（函数已删）+ 删 `--mode` 相关 it + `processChatLine` 10 个 it 改 harness 形态 + 新增 `src/cli/slash.ts` 新语义测试 + 删 `mode_change rebuilds agent`。
- **Affects**:
  - `tests/chat-repl.test.ts` —
    - `parseChatLine` describe（lines 14–55）+ `applySlashCommand` describe（lines 57–263）：**保留**，守旧 `src/interaction/slash.ts`，import 路径不变（从 `../src/interaction/index.ts`）
    - `chat session integration` describe（lines 265–302）：**重写**：删 `last_priors` 断言，改为 `priorMessages` 续传断言——两回合 pipe：第一回合后 `state.messages.length >= 2`，第二回合 `engine.run` 接收的 `priorMessages` 含第一回合 assistant 消息（用 fake adapter 驱动）
  - `tests/cli-session.test.ts` —
    - 删 `parseArgs` describe 中 `--mode` 解析的所有 it（if any）
    - 删 `resolveStartupMode` describe（lines 93–118）+ 全部 it（函数已删）
    - `slash /status` describe（lines 157–193）：改为 `applySlashCommand` 来自 `src/cli/slash.ts`（不是 `src/interaction/slash.ts`）；新断言：`messages.length` 取代 `turns.length`，`jsonMode` 取代 `json_mode`；去 `mode=` / `priors=` 行
    - `processChatLine (pipe simulation)` describe（lines 194–315）10 个 it：**改写**，适配 harness：
      - 不再传 `agent.answer(query, { prior_chunks, history })` —— 改为传 fake engine（提供 fake adapter + registry + executor）
      - 断言改 `state.messages` 取代 `state.turns/last_priors/history_finals`
      - empty/slash/query 三类行为不变，但 query 路径新断言 `engine.run` 被调一次 + `priorMessages: state.messages` 续传
    - 删 "mode change rebuilds agent" it（line 288, `/mode` 已删）
    - 删 `assert.match(/治理:|governance/i)` 断言（旧 `formatAnswerHuman` 的 governance 行已死）
    - **新增** `src/cli/slash.ts` 内部测试群（如果不在 T2 时已经放在 `tests/cli/slash.test.ts`，本 bullet 仅做 import 路径切换）
    - **新增** `src/cli/format.ts` 内部测试群（如果不在 T2 时已经放在 `tests/cli/format.test.ts`，本 bullet 仅做 import 路径切换）
  - `tests/interaction.test.ts` —— **不动**（一个字符都不改）
  - **新增** `tests/cli/process-chat-line-harness.test.ts`（如需要更深入的集成覆盖）：
    - 1 个 it: 两回合 pipe 续传 `priorMessages` 成功
    - 1 个 it: 单回合 slash `reset` 清空 messages 但 session.caller_role 保留
    - 1 个 it: slash `status` 渲染 messages.length（不是 turns.length）
- **Acceptance**:
  - `tests/chat-repl.test.ts`: parseChatLine + applySlashCommand describe 全过（守旧 slash 模块不破 Session API）□
  - `tests/chat-repl.test.ts`: chat session integration it 改写后过 □
  - `tests/cli-session.test.ts`: 全部 it 全过（删除的 it 也对应业务删了，无悬空断言）□
  - `tests/cli-session.test.ts` 不再 import 自 `../src/interaction/index.ts`（grep 自检通过——`src/interaction` import 路径全部切到 `../src/cli/*`）□
  - `tests/cli/format.test.ts` + `tests/cli/slash.test.ts` + `tests/cli/process-chat-line-harness.test.ts` 全过（如已建）□
  - `tests/interaction.test.ts` 全过（diff 为空或仅 git 操作）□
  - `tests/harness/*` 全套零回归（S1–S17 fixture）□
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T6, T7]`
- `[parallel]` — T5 可与 T4 并行不同文件；T5 仅需 T2 slice 的 format/slash 已就位（created in T2）

**实施要点**:

- `tests/chat-repl.test.ts` 的 split 重点：保留旧 slash 描述块 + 替换集成描述块 — grep `parseChatLine`/`applySlashCommand` 不动；grep `chat session integration` 触发重写
- `tests/cli-session.test.ts` 的 processChatLine 测试用 fake harness engine（fake adapter + stub model + demo tools），不接真实 SDK
- `tests/cli-session.test.ts:266` "json on switches answer formatting" 改：`/json on` 后输出包含 `"finalText"`/`"stopReason"`/`"turnCount"` 字段（harness 原生 JSON 形态）
- 不引入 vitest fake timers（同步 await 即可）
- 删 `assert.match(/治理:|governance/i)` 时同步删 `assert.match(/治理:|governance/i)` 来源（旧 formatAnswerHuman 的 governance 行）；新增 `assert.match` 针对新状态行：`stop=completed`
- `tests/interaction.test.ts` 完全不动这条是 hard rule；如果因 git 操作被 diff 覆盖，丢弃 diff

---

### T6. `[implementation]` `scripts/i10-cli-harness-smoke.ts` 真实 smoke + 证据落档

- **背景**: Q5.3 决议。slime 走 tsx 脚本（不进 `npm test`，对齐 019 i9 惯例 + I4 痕迹）。驱动 ask 路径 + chat pipe 路径两条；host-layer guard 自检；`.gitignore` 窄例外；证据落 `docs/handoff/i10-smoke/`。
- **Affects**:
  - `scripts/i10-cli-harness-smoke.ts` — **新增**：
    - 启动时 host-layer guard：读自身源码字符串，扫禁词 `["src/session-api", "src/interaction", "web/"]`，命中即 throw "host-layer guard: smoke must not reference <kw>" + exit 1（**只扫 3 个**，不扫 `src/cli`——smoke 必然 import 自 src/cli）
    - `loadIknowEnv()` 读 baseURL / apiKey / model；缺 apiKey → `console.error("set NINE_ROUTER_API_KEY or ANTHROPIC_API_KEY")` + `process.exitCode = 1` + return
    - `new Anthropic({ apiKey, baseURL })` 注入 `createRealAnthropicAdapter({ client, model, maxTokens: 1024 })`
    - `createRegistry([createEchoTool(), createGetTimeTool()])` + `createExecutor(registry)` + `createLoopEngine({ adapter: realAdapter, executor, registry, maxTurns: 6 })`
    - **ask 路径断言** (3 it):
      1. `result.stopReason === "completed"` — 正常停止
      2. `result.turnCount >= 2` — 多步
      3. `result.finalText` 非空 + `formatRunJson` 输出含 `"finalText"`/`"stopReason"`/`"turnCount"`/`"trace"` 字段（不包含 `"messages"`）
    - **chat pipe 路径断言** (3 it):
      1. 第一回合 `engine.run("echo hi then get time", opts)` → `result.stopReason === "completed"`
      2. 第二回合 `engine.run("the time was?", { priorMessages: 第一回合 result.messages })` → `result.messages.length > 第一回合 result.messages.length`（priorMessages 真的续传进去了）
      3. `formatRunHuman` 输出包含 `stop=completed` 与 `tools=echo,get_time`（顺序不强制）
  - `docs/handoff/i10-smoke/` — **新增目录**（smoke 跑通后落 `cli-harness.{json,md}`）
  - `.gitignore` — **窄例外**追加：`!docs/handoff/i10-smoke/`（参考 i4-smoke 已立的先例）
- **Acceptance**:
  - `node -e "require('fs').readFileSync('scripts/i10-cli-harness-smoke.ts', 'utf8')"` 不抛（脚本能跑）□
  - `npx tsx scripts/i10-cli-harness-smoke.ts` 在无 apiKey 时 exit 1 + stderr 含 "set NINE_ROUTER_API_KEY or ANTHROPIC_API_KEY" □
  - 在有 apiKey + 网关通时 exit 0 + 落 `docs/handoff/i10-smoke/cli-harness.json`（含 result=pass, timestamp, model, baseUrl, ask, chat—结构化 trace）+ 落 `cli-harness.md`（人读表格）□
  - 在有 apiKey + 网关通时跑通 6 条断言（操作员手测至少一次：smoke 至少跑通一次，符合 020 exit condition "完成 = 跑过 = ground truth"）□
  - 脚本源码不含 `src/session-api` / `src/interaction` / `web/`（host-layer guard 3 个禁词通过；允许 `src/cli`）□
  - `formatRunJson` 输出字段名为 harness 原生（`finalText`/`stopReason`/`turnCount`/`trace`，**不含** `messages`）□
  - 失败路径：模拟 apiKey 错时 exit 1 + 落 fail 文件 + 打 trace □
  - `npm run typecheck` 退出码 0（脚本走 tsc 编译）□
  - `npm test` 退出码 0（scripts/ 不在 vitest 默认 include 范围，但确认不破）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T7]`

**实施要点**:

- smoke 跑通不保证单次成功（真实流量有随机性），重跑到过为止（操作员手控）；smoke 设计不引入重试逻辑
- 失败回流（如模型偶发撞 maxTurns）不进 smoke 自动 retry，由 `docs/handoff/i10-smoke/*.md` 留档 + 必要时操作员开后续 ticket
- 不写进 `npm test` / `npm run smoke` / `npm scripts`；独立 `npx tsx scripts/i10-cli-harness-smoke.ts`
- 写文件用 `mkdirSync(outDir, { recursive: true })` 兜底目录存在
- `.md` 报告格式对齐 `docs/handoff/i9-smoke/real-anthropic-adapter.md` 风格（"Result: PASS/FAIL" + Check 表格）
- 不在 smoke 内 log 任何 key / baseURL 完整值（baseURL 只截到 host 不带 path）
- chat pipe 路径用顺序 await（不并行）确保第二回合 priorMessages 真的是第一回合输出
- `.gitignore` 加窄例外采用 `!docs/handoff/i10-smoke/*` 形式（参考 `.gitignore` 已有的 i4-smoke 例外写法）

---

### T7. `[implementation]` 集成验证 + D3-CLI 边界守门

- **背景**: 020 exit condition：CLI `ask` + `chat` 真实跑通 + 受牵连测试绿 + `npm run typecheck` + `npm test` 通过 + code review 确认 Session API + web 未被改动 + harness 套件不回归 + 旧 loop 仍存（021 退）。
- **Affects**:
  - 全量验证：
    - `npm run typecheck` 退出码 0
    - `npm test` 退出码 0（现有 24 suites + 新增 tests/cli/* 与 tests/chat-repl 分流后全部绿）
    - `npx tsx scripts/i10-cli-harness-smoke.ts` 跑通一次（操作员手测一次，记录 trace 到 `docs/handoff/i10-smoke/cli-harness.{json,md}`）
  - 代码审查（人工 reviewer 必走项）：
    - `git diff --stat HEAD~N..HEAD` 对每条 tracer bullet 的 `Affects` 文件清单做 scope 校验（无 scope creep）
    - **D3-CLI 守门 grep 自检**（脚本化）：
      - `! git diff origin/master... -- src/interaction/ | grep -E '^\+' | head`（src/interaction/* 020 应零行变化）
      - `! git diff origin/master... -- src/session-api/ | grep -E '^\+' | head`（src/session-api/* 020 应零行变化）
      - `! git diff origin/master... -- web/ | grep -E '^\+' | head`（web/* 020 应零行变化）
      - `! git diff origin/master... -- src/shared/schema.ts | grep -E '^\+' | head`（IknowAnswer 不变）
      - `! git diff origin/master... -- src/agent-loop/ | grep -E '^\+' | head`（旧 loop 留给 021）
- **Acceptance**:
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0（新增 ≥ X 个 it 全过；harness S1–S17 零回归）□
  - `npx tsx scripts/i10-cli-harness-smoke.ts` 跑通 6 条断言，`docs/handoff/i10-smoke/cli-harness.json` 存在且 `result === "pass"`，`.md` 报告记录全过 □
  - `tests/harness/public-exports.test.ts` 公共出口断言过 + Gate B 禁词表扫描过 □
  - 014 / 015 / 016 / 017 / 019 冻结契约零变更（grep `interpretMessage`/`encodeUserText`/`encodeToolResults`/`StopReason`/`ToolExecutionResult`/`executeAll`/`raceModel`/`LoopState`/`RunResult`/`createRealAnthropicAdapter` 等 SSOT 形状未改，T1 唯一新增的 `priorMessages` 是可选参不算契约变化）□
  - D3-CLI 守门 5 条 grep 自检全过：`src/interaction/*` / `src/session-api/*` / `web/*` / `src/shared/schema.ts` / `src/agent-loop/*` 在 PR 内零行 `+` change □
  - 真实失败回流（若有）已留档到 `docs/handoff/i10-smoke/*.md` notes 段 + 后续 ticket（按需开） □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T2, T3, T4, T5, T6]`

**实施要点**:

- 本 tracer bullet 是"集成 + 真值证据"，不是新代码；只 commit 公共出口最终对齐（如有遗漏 export 补齐）+ smoke 真值证据落档
- 操作员手测 smoke 是 "完成 = 实测过" 必走项（CLAUDE.md 顶上明文）
- 若 smoke 跑出未预料的失败，**不在本 plan 修复**；开后续 ticket 走 #47 Resolution "真实失败回流进后续票不修" 惯例
- #54 (#023 raceModel abort) 是已立并行 followup，**不在本 plan 范围**；本 plan 不修改 `raceModel`、不修改 `executeAll`、不动 engine 错误路由
- D3-CLI 守门 grep 自检可脚本化为 `scripts/d3-cli-gate.sh`（或 vitest integration test）但本 bullet 手动验证即可；后续 #51 ticket 会复用同一守门脚本
- 实测路径可以是 `node --experimental-strip-types ./src/cli.ts ask "hello"` + pipe `echo "查询1\n查询2" | node --experimental-strip-types ./src/cli.ts chat`（脚本是 tsx 调更便利）

---

## Dependency Graph

```
T1 [implementation] ── harness run() 加 opts.priorMessages（src/harness/loop-engine.ts）
   │
   ├────────────────────────────┐
   ▼                            ▼
T2 [implementation]      T3 [implementation]
src/cli/format.ts        src/cli/runtime.ts
+ src/cli/slash.ts        buildAgent 真实装配
（parallel 与 T3）        + 删 mode 分支
   │                            │
   │                            │ T2、T3 都 [blocks: T4, T5]
   ▼                            ▼
        T4 [implementation]
        src/cli/chat-session.ts
        + src/cli.ts
        + src/cli/parse-args.ts
        （host 层装配）
                │
                ▼
        T5 [implementation]
        受牵连测试改写
        （3 个 test 文件分流）
                │
                ▼
        T6 [implementation]
        scripts/i10-cli-harness-smoke.ts
        + docs/handoff/i10-smoke/
        + .gitignore 窄例外
                │
                ▼
        T7 [implementation]
        集成验证 + D3-CLI 守门
        [blocks: T1, T2, T3, T4, T5, T6]
```

---

## Cross-references

- **architecture-change-reviewer verdict**: yes per all 5 Core Skills（见 Section 2 ACR 5-verdict block；自评因走 gh-22 skip 路径未跑 `arthurpower:architecture-change-reviewer` 子代理；如操作员要求额外自评，可派 `arthurpower:architecture-change-reviewer-agent` 子代理以正式 ACR verdict 替换 Section 2 自评）
- **affected S1-S6 skills**:
  - S1 bounded-context: 改动收敛在 `src/cli/*` + `src/harness/loop-engine.ts`（1 行）+ `scripts/i10-*` + `tests/*` 受牵连；`src/interaction/*` / `src/session-api/*` / `web/*` / `src/shared/schema.ts` / `src/agent-loop/*` 020 一字不动
  - S2 defensive-contract: `run()` 加的 `opts.priorMessages` 是可选参，默认行为不变（016/017 守门）；smoke 6 条断言守真实多步闭环 + 续传；T5 测试覆盖 processChatLine 三类行为
  - S3 error-handling: 不新增错误类（沿用 harness 既有错误路由，019 已锁）；CLI host 不新增错误码
  - S4 test-coverage: T1 新增 3 it（harness loop-engine.priorMessages）；T2 新增 ~15 it（format + slash 各自 7 + 8 个 it）；T5 改写 cli-session.test.ts ~10 it + chat-repl.test.ts 集成块；T6 smoke 真值 6 断言
  - S5 complexity-anti-drift: formatRunHuman ~30 行；formatRunJson ~10 行；src/cli/slash.ts ~80–110 行；processChatLine 改后 ~50 行；buildAgent 改后 ~50 行；file ≤ 500 soft cap 全守
  - S6 minimal-change: 无新依赖；diff 限 src/harness/（1 行）+ src/cli/*（~5 文件改/新）+ scripts/（1 新）+ tests/ 受牵连改写 + docs/handoff/i10-smoke/；不动 014/015/016/017/019 冻结契约；1 commit = 1 bullet
- **parallelization surface**: T2 (CLI format + slash) 与 T3 (runtime buildAgent) 在不同文件 + 无共享状态，可以真正并行 commit/push。T5 与 T4 也可并行。T6 必须等 T5 完成才能测真实路径。T7 必须最后。
- **Gantt** (commit order): T1 → {T2 ∥ T3} → T4 → T5 → T6 → T7（每条 commit 独立 branch off `worktree-wayfinder-gh-collab-adapt`）
- **related tickets**:
  - #46 (019) closed 2026-07-29 ✓ — 直接上游，决策接口源
  - #47 (020) closed 2026-07-30 ✓ — 本 plan 决策收口源（Q1–Q5）
  - #54 (#023 engine-timeout HTTP 未取消) open — 并行 followup，本 plan 不实施
  - #48 (021) blocked by 020 ✓ → 解锁为 NEXT（砍旧 EVAL + 退役旧 src/agent-loop/）
  - #51 (022 Session API 迁移) blocked by 020 ✓ + 021 — 后续，020 不直接相关但 D3-CLI 守门对 #51 重要

---

## Verification Checklist

- [x] Plan has ≥ 3 tracer bullets → **7 bullets** (T1/T2/T3/T4/T5/T6/T7 implementation)
- [x] Each bullet has 1+ binary acceptance criterion → yes
- [x] Each bullet maps to exactly 1 commit → yes
- [x] Bullets ordered by dependency → yes (T1 → {T2 ∥ T3} → T4 → T5 → T6 → T7)
- [x] Plan lives in `plans/cli-path-to-harness.md` → yes
- [x] ACR 5-verdict block present in Section 2 → yes（自评；gh-22 skip 路径）
- [x] Context-loop pre-check in Section 1 → yes
- [x] Per-ticket loop embedded in each `[implementation]` bullet → yes
- [x] Tracker = GitHub issues (main path, gh CLI available) → ready-for-agent label
- [x] Does NOT touch src/interaction/* (D3-CLI gate) → yes
- [x] Does NOT touch src/session-api/* (D3-CLI gate) → yes
- [x] Does NOT touch web/* (D3-CLI gate) → yes
- [x] Does NOT touch src/shared/schema.ts (IknowAnswer, D3-CLI gate) → yes
- [x] Does NOT touch src/agent-loop/* (deferred to 021) → yes
- [x] Does NOT modify 014/015/016/017/019 frozen contracts → yes (T1 priorMessages 是可选参非契约变化)
- [x] Does NOT modify raceModel (017 frozen, #54 followup outside this plan) → yes
- [x] Smoke artifact lands in `docs/handoff/i10-smoke/` per i9/I4 convention (`.gitignore` 窄例外) → yes
- [x] Real smoke proves CLI ask + chat pipe paths both run with real Anthropic SDK + harness + demo tools → yes (T6 + T7)
