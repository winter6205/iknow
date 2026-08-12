# CONTEXT.md — iknow 领域词汇表

> 项目领域词汇的**单一事实源 (SSOT)**. 仅 `domain-modeling` 技能可写; 其他消费者按
> `docs/agents/context-contract.md` 消费.
> 本文件只收录**当前活跃术语**；完整历史版本保留于 git 历史.

---

## Language

**Loop Engine**: Foundation 的状态机运行内核，驱动模型 -> 工具 -> 真实结果 -> 下一轮模型 -> 明确停止；位于 `src/harness/`，作为 018 退役旧 loop 后的可靠运行时基础。
_Avoid_: 与旧 `IknowAgent` / `LlmIknowAgent` 混同；将泛称 "agent loop" 当作本项目术语

**append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。
_Avoid_: 任何 host 层第二份权威历史；任意形式的"编辑历史"

**turnCount**: Foundation 运行时回合计数，每完成一个 assistant 回合（包括纯文本完成）加一；`maxTurns` 是在调用模型前检查的运行时上限。
_Avoid_: steps、retries

**stub model / stub tool**: Foundation 的确定性测试替身，覆盖真实模型或工具交通之外的完成、失败与停止行为；016 验 Gate A（S1–S11），017 起也验 Gate B required runtime layer（S12–S17 signal/timeout/trace），其中 `stub-signal-tool` 是 S17（ctx.signal -> AbortError -> execution_failed）的守门载体。不进生产装配路径。
_Avoid_: 声称已接入产品路径；mock agent、stub brain

**StopReason**: Loop Engine 的七类停止判别联合——016 五类（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse）末尾追加 017 两类 `cancelled`（signal abort）与 `timeout`（超时强制）；追加不重排，Transition 形状随之自动扩展。
_Avoid_: 把 cancelled 与 timeout 混为一条；把总耗时当作独立 stop 触发器

**LoopTrace**: `run()` 的第二返回面 `{ result, trace }`（TurnTrace / Totals 两型）—— A 层结构元数据 trace（每回合 supplierStop / toolCall kind / durationMs / cancelKind + 一次性 reduce 的 totals），严格不含 payload；与 append-only messages 唯一权威解耦，immutable 累积。`cancelKind` 是取消来源四值枚举 `"none" | "callerAbort" | "timerTimeout" | "hostCancel"`.
_Avoid_: 在 trace 里塞 input/output/token/cost（B 层字段）——该禁令仅对 LoopTrace 本体，不外延到 TraceService（`LlmCallRecord` 承载 token usage 是 ADR-0008 裁决的合规落点）

**usage (token accounting)**: LLM API 每次成功调用回传的 token 计费（`inputTokens`/`outputTokens` 必填 + `cacheCreationInputTokens`/`cacheReadInputTokens` nullable，对齐 SDK `Usage`）；权威落点 = TraceService `LlmCallRecord`（观测真值，错误分支整条缺席），运行时暴露面仅 `RunResult.lastUsage`（TUI 显示读者，017:67 的有记录例外）。chars/N 估算只供压缩决策，永不进核算 / 显示（ADR-0008）。
_Avoid_: 用估算值顶替 trace 真值；为无读者的账本建运行时承载面；把 usage 塞进 LoopTrace

**context usage (display)**: 上下文用量显示 = TUI `ContextBar`（`src/tui/context-bar.tsx`）+ Web `ContextUsageStrip`（`web/src/components/ContextUsageStrip.tsx`）共同消费 `RunResult.lastUsage`（ADR-0008 D5）；wire 字段 = `TurnAnswerDto.lastUsage?` + `HealthResponse.contextWindow`（`src/session-api/` 投影，web 镜像于 `web/src/api/types.ts`）。百分比分子 = `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`（Anthropic 三类 token 互不相交）；分母 = `contextWindow`（来源 `env.compress.contextWindow`，env var `IKNOW_MODEL_CONTEXT_WINDOW`，默认 200000）。Running 时显示上一次已完成的 lastUsage（one-beat lag）。
_Avoid_: 用 chars/N 估算顶替 lastUsage 真值；为显示引入第二份 token 账本；让 contextWindow 走 `deps.compress`（避免触发 auto-compaction 行为变化）

**ToolExecutionContext**: Executor 透传给 handler 的执行上下文 `{ signal }`；run 第三参 signal 原样透传、不创建子 signal，超时由 Executor `Promise.race` 外包而非 ctx 携带。
_Avoid_: 在 ctx 里放 timeoutMs；为每个 handler 建子 AbortController

**in-flight closeout**: abort/timeout 发生时的收尾语义——模型在途则整回合不进历史（finalState = 入口 state）；工具在途则 assistant 回合已原子追加（不可回滚），在途 tool call 填 `execution_failed`（message 固定 "cancelled"/"timeout"），所有 tool_result 编码为一条 user message 原子追加后 stop。signal 优先于 timeout。
_Avoid_: 回滚已追加的 assistant 回合；悬空未回填的 tool call

**required runtime layer / conditional remediation layer**: 017 的两层对仗边界——required runtime layer（signal / timeout / trace / cancelled-timeout 停止 / in-flight closeout）已实施；conditional remediation layer（自动重试、token-cost 护栏、trace B 层字段、工具分类超时、错误分类细化、总耗时独立 stop、OTel-span-metric 树）017 显式禁止，推迟到 018 真实接通后按 013 条件式修复原则补。
_Avoid_: 把 conditional remediation layer 提前带入 Foundation 内核

**executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段，executor 永不信任工具声称的截断字段（防 MCP 第三方伪造绕过封顶）。#140 裁决，ADR-0004 / ADR-0006。
_Avoid_: 工具自填 truncated/total 字段；executor 凭工具标记跳过兜底截断

**plain-string tool output**: (契约 Y1, deprecated→#298) 原生产工具输出为纯字符串（对齐 OpenHarness wire 形态）；bash 例外保留 `{code, stdout, stderr}`（Y1b）。#298 起 Y1「纯字符串」读法被 observability side-channel 取代——model-facing tool_result 仍纯字符串（Y1 精神保留），但 handler 可返 envelope `{ output, meta? }`，`meta` 走观测旁路，永不进模型视野。#140 裁决，ADR-0004。
_Avoid_: 工具自填 structured metadata 进 model tool_result；把 bash 例外推广到其他工具

**observability side-channel**: (#298) 工具观测旁路——handler 返 envelope `{ output, meta? }`；executor 拆分后仅 `output` 字符串化进 model-facing tool_result，`meta`（典型如 edit_file/write_file 的 `oldContent`/`newContent`）经 `PostToolUseHook.payload` → `TuiToolEvent.payload` → `LiveToolRun` 字段供 TUI diff 预览等观测消费者，永不进模型视野。ADR-0004（supersede Y1）。
_Avoid_: 把 meta 拼入 model tool_result；让 TUI / Web 直接读 handler 原始返回对象

**ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；当前 8 件：`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移（#141 / #191 / a277f68）。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。
_Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组（#228 决议 D4——`memory_recall` / `memory_save` 入 SSOT 8+2=10）；让工具返回结构化 metadata

**deps.system injection seam**: Each-turn 系统文本装配的唯一权威缝——loop-engine 调 `deps.system?.()`（`loop-engine.ts:358`），结果透传 `adapter.step request.system`；`undefined` 时不发送 `system` 字段（`anthropic-adapter.ts:577-580` 条件 spread），KV cache 前缀字节级稳定。装配主体是 `identity/assemble.ts` 的 `IKNOW_ASSEMBLY_ORDER` 流水线（#196）。
_Avoid_: 在 adapter 或 host 层直接拼系统；发送空串 `system`（KV cache jitter）；绕开 `deps.system` 在 adapter 内部二次组装

**memory_layer slot**: #196 9 段流水线 slots 5-9（user AGENTS / `PRIORITY_DECLARATION` / project AGENTS / `EXISTENCE_POINTER` / promote 段）收敛后的单 slot 名，位置仍在 bootstrap 之后；委托 #121 `createSystemResolver`（`memory/refresh.ts`：mtime 缓存 + inflight 去重 + 装配失败不毒化缓存），内部拼接顺序由 ADR-0009 锁定。#228 决议 D2。
_Avoid_: 逐 slot 独立消费缓存；再拆拼接后的整串；把拼接顺序拆出 slot 边界独立决策

**surface split (identity vs memory)**: 入口面（`chat` / `tui` / `ask` / `serve`）的两层语义——身份认知层（`identity` / `soul` / `user_profile` + 仅 chat/tui 触发的 `bootstrap`）恒在；记忆层（`AGENTS.md` + rules + 记忆库 + `memory_recall` / `memory_save` 工具）只对 chat / tui / serve 装配，`ask` 全 opt-out（`memory_layer` slot 不挂、memory 工具不入注册表）。#228 决议 D3。
_Avoid_: `ask` 全 opt-out（破"我是谁"答复路径）；`ask` 全 opt-in（破 #121 "ask 无状态"前提）；按 surface flag 同时决定两层

**chat REPL** / **product CLI**: TTY interactive `iknow chat`（或裸 TTY invoke）的人类视图；管道模式为串行非终端 turn。
_Avoid_: 把 one-shot JSON `ask` 当作交互产品；管道上 `terminal: true`；空 `ask` 时塞默认 demo query

**oneshot / ask**: 脚本/CI 路径：单次问题 -> JSON on stdout；空 query -> usage + exit 1。
_Avoid_: 空参数时塞中文 demo query

**Session HTTP API** / **session-api**: Host 多会话面（`src/session-api/`，`node:http`）：create / message / command / reset；每条 message 返回 JSON；非 tool schema。
_Avoid_: 在 Session API 之外另起前端直连；把 harness 工具逐一包成 REST

**iknow serve**: CLI host，跑 Session API + 静态产品 UI（`web/dist` 优先，回退 `web/`）。
_Avoid_: 把 frontend-only server 当生产路径但不代理 `/api`

**product SPA (web/)**: Vite + React + TypeScript chat console；同源 Session client；JSON 侧栏。
_Avoid_: 零依赖静态壳当产品；展示层省略 trace 字段

**streaming arm**: LLM 客户端默认流式臂（`IKNOW_LLM_STREAM` 值域 `on | off`，默认 `on`，`env.ts` SSOT），`off` 回退非流式臂；原生 SSE 事件不出 adapter 边界，收敛为 `HarnessStreamEvent` 最小集（`text_delta` / `tool_call_start`，`src/harness/stream.ts`），终态经 SDK `finalMessage()` -> `interpretMessage`（SSOT）落为同形 `AssistantTurnResult`。
_Avoid_: 把 `stream: false` + 裸 JSON 解析当默认 LLM 臂；让原生 SSE 事件逸出 adapter 边界

**project stack defaults (SSOT boundary) — settings 单承载收敛 (ADR-0015)**: LLM 配置收敛到 `~/.iknow/settings.json`（user）+ `<cwd>/.iknow/settings.json`（project 覆盖 user）单承载（ADR-0015 / `plans/settings-model-extension.md`）。

- `settings.llm.model`（字面值，唯一来源，trim 后非空串）: 模型路由 ID 的全局可寻址位；缺失 → `loadIknowEnv` fail-fast 抛「no LLM model configured in settings.llm.model」，不再有 hardcoded 兜底。
- `settings.llm.apiKey`（字面或 `${VAR}` / `$VAR` 占位符）: 唯一 key 承载。字面 → 原样；占位符 → 经 `expandPlaceholders` 从 `process.env[VAR]` 优先 / `.env.local` / `.env` 兜底解析。解析不到 → undefined（消费点守卫抛「no API key configured」）。
- `settings.llm.fallback?: string[]`: 用户自配的模型 fallback 列表（代码不预置任何 fallback）。
  **退役机制**: `IKNOW_LLM_MODEL`（env 覆盖 model）已不再读取；`IKNOW_LLM_API_KEY_ENV`（env 覆盖 key 变量名）已不再读取；`LlmEnv.apiKeyEnv` 字段已删。`IKNOW_LLM_BASE_URL` 仍读（provider/baseUrl 是 9router 项目级决策，保留为代码默认 fallback）。`.env.local` 退化为「占位符真值源」（`.env.local` 持有 `${VAR}` 指向的变量值本身），不再是 model / key 变量名的配置口。
  **保留机制**: provider = 9router、`baseUrl` 代码默认 `http://localhost:20128/v1` 焊进 `env.ts`（`IKNOW_LLM_BASE_URL` 仍读）；非 LLM 字段（context window / maxTurns / web 端点 / mcp 超时等）的 `process.env > .env.local > .env` 优先级链不变。
  _Avoid_: 在 `.env.local` 重复声明已与代码默认一致的非密项；把 model 切换当「每机配置」而非「项目栈决策」

**前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`，显式选项）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程，与前景/后景正交。
_Avoid_: 把前景/后景与进程隔离混同；泛化的"同步/异步"；把 V1"立即返回 task_id"当默认契约（已被反转）

**host drain**: host 侧把 completed 子代理 envelope 浓缩成一条消息、注入下一轮 run() priorMessages 的机制（#356 V1，`src/harness/subagent/host-drain.ts`）；只 drain completed，不修改 buffer 状态。#361 裁决后仅在异步臂（`wait:false`）生效，且须阻塞轮询至至少一个 worker 到终态；终态被 V2 事件驱动唤醒取代。
_Avoid_: 把 drain 与"结果获取"混同（前景 spawn 不经 drain）；让 agent 侧直接消费 manager buffer；把 drain 被动挂"下一轮用户输入"当作可靠唤醒源

## Relationships

- **run() messages -> adapter streaming arm -> interpretMessage**: harness LLM path（流事件以 `HarnessStreamEvent` 经 `onStream` 暴露）
- **turn -> LoopEngine -> tool call -> result -> next turn**: harness 驱动；tool use 经 ACI permission middleware
- **Session HTTP -> run() -> AssistantTurnResult -> SessionHub**: session-api host 路径；messages 每回合投影到 UI

## Flagged ambiguities

- **gbrain vs iknow runtime**: `_upstream_gbrain/` is READ-ONLY design reference; product runtime is standalone `iknow` with **zero** import/link to gbrain
- **ordinal vs ts**: log field is `ordinal` (1-based sequence)；不用 `ts` 表示 tool call 顺序
- **chat vs test harness**: product CLI is TTY/pipe-aware session code under `src/cli/`；单元测试调内部 helper 时不得声称这就是产品 UX
- **9router stack probe**: 同 key 可使 `models` 200 而 `chat/completions` 401；agent shell env 与 operator 交互 shell 可能不同（探针 `scripts/i4-probe-nine-endpoints.ts`）
- **streaming arm vs native SSE**: LLM 默认 SDK 流式臂（`IKNOW_LLM_STREAM`，默认 `on`，`env.ts` SSOT）；原生 SSE 事件不出 adapter 边界，host 只见 `HarnessStreamEvent`；`off` 回退非流式臂，网关响应由 SDK 统一消化，host 不直接解析 wire
- **turnCount vs harness maxTurns**: `turnCount` 统计每个已完成的 assistant 回合；`maxTurns` 是 run() 入口处的运行上限；二者不要混用
- **cancelled vs timeout**: 两条独立停止路径——cancelled 由 Loop Engine 检测 `signal.aborted`，timeout 由 adapter/executor 超时结果判定；signal 优先，不在 signal 层合并超时
- **LoopTrace vs messages**: LoopTrace 是非权威 A 层结构元数据（不含 payload），messages 才是 append-only 唯一权威历史；trace 只用于诊断聚合，不得作为第二份权威副本
- **project stack defaults vs .env.local**: env.ts 代码默认是项目级栈 SSOT（ADR-0001）；`.env.local` 重复声明同值非密项会形成第二源 / drift。`.env.local` 职责 = 密钥值 + 机器级覆盖，不是重新声明栈
- **next phase focus**: harness tool surface 扩展 + session 持久化 + I4 风格的 live smoke

---

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

```bash
bash scripts/bootstrap.sh --interactive
```

---

**Maintenance cadence**: monthly review per project memory rules.
