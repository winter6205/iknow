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

**声明工具面 vs 实际工具面**: `SubAgentDefinition.disallowedTools` 写进 `WorkerEnvelope` 的是声明面；worker 进程装配后真正可被模型调用的工具集是实际面，二者必须相等——裁剪发生在 `createAciRegistry(tools)` **之前**的 def-list 期（`createDefaultAciRegistry` 工厂内），由构造期快照保证，不事后修补（`AciRegistry.inner` 是冻结快照）。
_Avoid_: 给 `AciRegistry` 加 `.tools` 字段在产物上事后裁剪；声明 deny-list 但 worker 不消费（#468 修复对象）

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

**workspace（serve 主根）**: 用户在 product SPA 选定的已存在绝对目录；Web 上唯一项目锚。绑定后三锚合一。ADR-0023：serve 缺省不是 cwd。
_Avoid_: 把 serve 缺省说成 `process.cwd()`；与 `workspaceRoot` 字段、`home`（global 配置锚）、`sandboxRoot` 混同

**workspaceRoot**: per-root 操作状态锚（memory / sessions / tasks / settings 写回 fallback / serve data）；默认 `process.cwd()`，可被 `--workspace-root` 或 `IKNOW_WORKSPACE_ROOT` 覆盖。不含用户画像。ADR-0019 D1.1；画像根见 ADR-0025。
_Avoid_: 用 workspaceRoot 当 `user.md` / `BOOTSTRAP.md` 的物理根；把 identity seed 跟启动目录绑在一起

**user.md**: 全局用户画像，唯一落点 `~/.iknow/user.md`（测试缝 = `userHome/.iknow/user.md`）；每 turn 注入 `user_profile` 段，改文件下一轮生效。ADR-0025。
_Avoid_: 项目 `.iknow/user.md`；per-root persona；把画像当成 workspace 状态

**BOOTSTRAP.md**: 首启引导种子，与 `user.md` 同根（`~/.iknow/BOOTSTRAP.md`）；文件存在则注入 bootstrap 段，agent 删除该文件即完成。`state.json.bootstrap_seeded` 只防止重复 seed，不是完成条件。
_Avoid_: 每个仓库一份 BOOTSTRAP；用 workspaceRoot 下的 BOOTSTRAP.md 当引导；把 bootstrap_seeded=true 当成「用户已填完画像」

**unbound**: serve hub 尚未绑定主根。此时不得 buildHarnessEngine 用进程 cwd，不得 postMessage。
_Avoid_: unbound 时 buildHarnessEngine 或 postMessage；把 unbound 说成「默认 cwd」

**product SPA (web/)**: Vite + React + TypeScript chat console；同源 Session client；JSON 侧栏。
_Avoid_: 零依赖静态壳当产品；展示层省略 trace 字段

**正常模式**: 默认 HITL 产品：每轮说完把回合还给用户；完成向 LLM 关闭；硬失败打回干活模型。
_Avoid_: 每个 completed 请 LLM 评「做完没」；先问有没有 goal 再决定怎么判

**自动模式**: `/goal` / `## GOAL:` 钉上后的无人值守循环，直到条件成立、判官 Impossible、不可恢复错误、可选轮次上限或用户 clear；空转停循环但 goal 可留着。
_Avoid_: 把自动模式当成 verify 链上的第一道 if；自动模式里再用 taskFocus 当使命

**goal（会话使命）**: 自动模式的完成条件，只由 `/goal <text>` / `## GOAL:` 写入（`source = user_pin`），仅 `/goal clear` 或停档清掉；钉上即进入自动模式。
_Avoid_: `goal.text ?? query` 当验收任务；把 goal 当模型可推进的活对象；模型输出 / 工具结果 / 文件内容写 goal

**taskFocus（任务焦点）**: 正常模式 compact 保焦对象（确定性提取，v1 不用 LLM）；寒暄不 seed，像样任务句写入一次后不自动切；仅 compact 边界渲染；自动模式内不存在。
_Avoid_: 用 LLM 摘要；普通 turn 注入；当完成验收对象或 `/goal` 的第二张焦点卡；首条「你好」当终身焦点

**task 取值公式**: 无统一 `??` 链。自动模式判官 `task = goal.text`（无 fallback）；正常模式不设完成向 `task`。
_Avoid_: `goal ?? taskFocus ?? query`；`goal.text ?? query`；把 evidenceContext 拼进 task

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

**外挂自检层 (external self-check layer)**: (#128 决议 D1) orchestrator 层的 advisor 形态验证闭环——`run()` 以完成收尾后执行项目 settings 声明的验证命令，失败则把结构化错误经 `priorMessages` 注入并再次 `run()`；引擎零改动、停止语义保持冻结，与引擎自带的工具级实时纠错（第一层）互补而非替代。
_Avoid_: 把它当引擎内行为（enforcer 形态）；与第一层工具错误自动回流混同；说成"Stop 钩子拦截循环"

**失败签名 (failure signature)**: 单轮验证失败的归一化标识——退出码 + 失败用例名/首行错误，供停滞与趋势判定比对；只有复现过的真失败进签名序列。
_Avoid_: 拿原始输出全文当签名；让 flaky 项污染签名序列

**三态判定 (tri-state verdict)**: 验证结果判定 = pass / 真失败 / 不稳定（全量挂但单跑过）；不稳定不触发修正、不静默放过，收尾报告标注；仅真失败进修正闭环与趋势判定。
_Avoid_: 二元 pass/fail；静默放行不稳定项；把套件干扰判成模型错误

**确认阶梯 (confirmation ladder)**: 失败采信前的两级确认——全量复跑一次 → 失败用例单跑（可选复跑模板配置）；每级至多一次不递归，全过才判 flaky，全不过才判真失败。
_Avoid_: 单次失败直接判真；复跑递归；无复跑模板时强行解析框架输出

**趋势判定 (trend-based stop)**: 修正轮次的控制准则——进展（失败数优于历史最好）放行 / 同签名停滞停 / 连续两轮差于最好成绩停，允许 1 轮震荡宽容；总轮数上限仅兜底。裁判是趋势不是计数器。
_Avoid_: 固定轮数一刀切；单轮退化即停；无兜底上限

**escalate 模式**: 修正耗尽后的可选处置（默认 report 停止+如实报告）——注入升级指令（禁止重复同一修复、换思路或明确报告阻塞）并给新预算继续；总预算不重置。服务长程自主任务。
_Avoid_: 把 escalate 当无限轮次；降级放行（验证未通过算完成）

**判官（judge）**: 共用的只读 LLM 分类器系统（四态；内环 `maxTurns: 2`）；完成向评价只挂自动模式逻辑模块。
_Avoid_: 另起一个自动模式专用判官产品；command 缺失就当总开关每轮请判官；给判官执行能力；与 evidence-checker 混同

**checker 三态 verdict**: 证据充分性判定 = `EVIDENCE_SUFFICIENT` / `EVIDENCE_CONTRADICTED` / `EVIDENCE_INSUFFICIENT`；6 条检查封装在 `evidence-checker.ts` 内部。HITL 用它做硬失败/补跑；自动模式里它只进 `evidenceContext` 当提示，绿了仍要 LLM 评 `goal.text`。
_Avoid_: 与闭环「三态判定」混同；调用方自数 PASS 条件；`SUFFICIENT` 当作自动模式已完成

**green marker**: 测试框架输出里的通过摘要行（白名单 pytest / jest / vitest / go test / cargo test）；checker 只从框架摘要行读通过数字。
_Avoid_: 扫描任意 stdout 判绿；白名单外自造框架解析

**弱绿（weak green）**: exit 0 但不代表整套过的绿——`0 tests run` / `collected 0 items` / `no tests found` / 窄跑（`-k` / `-t` / `::`）；弱绿不算充分证据。
_Avoid_: 把 exit 0 当测试通过

**unverified**: 判官第 4 态——判官工作正常，但读完证据后认为不足以判定完成，拒绝猜 PASS/FAIL；映射到 `unstable`（停止、不注入信封、结果原样返回用户），与 `abort`（判官自身 transport/schema/超时故障）严格区分，`VerificationRecord.reason` 落盘区分。
_Avoid_: 把 unverified 猜成 pass 或 fail（"a verifier that bluffs is worse than none"）；与 abort 混同

**evidenceContext（证据体检单）**: 判官信封独立字段（checker 三态、缺因、已跑命令、摘要，宿主截断 ≤ 20000 codepoints）；是提示不是考题，`SUFFICIENT` 不是自动模式 PASS 通行证。
_Avoid_: 把证据塞进 task 字段；注入前不截断；让判官去回答这张 JSON

**补跑信封**: `EVIDENCE_INSUFFICIENT` 时注入主会话的反馈信封（"你声称完成，但缺真实测试证据 + 原因 + 请跑 <命令> 并展示框架通过摘要"）；命令来源 = 用户 `verify.command` 优先，否则 D2 探测；每闭环至多 1 次。
_Avoid_: 与 `[VALIDATION FAILED]` 失败信封混同（补跑信封用 `[VERIFY: rerun needed]` 前缀）；无限补跑轮

**D2 自动探测**: 无 `verify.command` 时按项目标志文件探测默认验证命令（pyproject/pytest.ini→pytest、package.json vitest/jest dep→对应 runner、go.mod→go test、Cargo.toml→cargo test）；冲突或无标志 → null（fail-closed，落判官）。
_Avoid_: 多标志冲突时猜命令；把探测结果当必跑命令

**双重承载面 (hook dual surfaces)**: (#126 决议 D1) 钩子系统的正式形态——引擎内承载面（Pre/PostToolUse，挂 permission-executor 5 步链，工具级/同步/无状态）+ 引擎外承载面（Stop，host/orchestrator 层订阅 `run()` completed 返回，任务级/多轮/有策略状态，实现即 #128 外挂自检层）。Stop 钩子的触发事件是 host 侧观察到的 run() 返回，不是引擎 Transition。
_Avoid_: 把三类钩子塞进单一承载机制；把 Stop 映射到 step() Transition；把双重承载面当设计缺陷而非分层结果

**hook failure semantics (fail-closed / fire-and-forget)**: (#126 决议 D3) 引擎内钩子的异常语义分裂——Pre 钩子抛异常 fail-closed（该调用判 `execution_failed` + `hook_error` 前缀回灌模型，loop 不炸）；Post 钩子抛异常 fire-and-forget（只记录、不影响结果，观测层不反噬执行层）。钩子必须同步纯函数、禁慢 IO；慢验证归 Stop 承载面。
_Avoid_: Pre 失败 fail-open 静默放行；Post 异常推翻已成功的调用结果；钩子内做慢 IO 或异步调用

**secrets guard**: (#126 决议 D6) Pre 缝第一个真实产品消费者——密钥模式拦截钩子，拦「工具调用参数内容夹带密钥/凭据」，与 hard-wall（命令形态 + 敏感路径）互补不重叠；模式来源双层：代码内置默认集 + 项目 settings 覆盖/追加，接入 `createAciExecutor` 产品路径。
_Avoid_: 与 hard-wall 职责混同；Pre 缝保持零产品消费者；把它当密钥防护唯一道防线

## Relationships

- **run() messages -> adapter streaming arm -> interpretMessage**: harness LLM path（流事件以 `HarnessStreamEvent` 经 `onStream` 暴露）
- **turn -> LoopEngine -> tool call -> result -> next turn**: harness 驱动；tool use 经 ACI permission middleware
- **Session HTTP -> run() -> AssistantTurnResult -> SessionHub**: session-api host 路径；messages 每回合投影到 UI
- **正常模式 vs 自动模式**: 默认 HITL 与 `/goal` 循环是两套判断逻辑模块，共用判官系统；不是一条 `goal ?? query` 链

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
- **secret-roundtrip mask（#406）**: 用户文本中的密钥形态被识别层替换为 `<<<SECRET_N>>>` 占位符（N 从 1 单调递增，per-engine registry 共享，in-memory 不落盘）；bash 工具 spawn 前 `restore()` 回填真值；输出 mask 经 `currentSecretValues(registry.values())` 兜底遮蔽。**session 重启后历史占位符无法还原**（registry 非持久化，占位符原样透传不抛——acceptable limitation）。`settings.secrets.mode` 控制 `roundtrip`（默认）| `block`（#126 deny-only guard 兼容）
- **next phase focus**: harness tool surface 扩展 + session 持久化 + I4 风格的 live smoke
- **goal vs taskFocus vs 判官 task**: goal 只开自动模式；taskFocus 只 HITL compact；完成向 `task` 仅自动模式的 `goal.text`（ADR-0024）

---

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

```bash
bash scripts/bootstrap.sh --interactive
```

---

**Maintenance cadence**: monthly review per project memory rules.
