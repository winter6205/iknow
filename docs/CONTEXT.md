# CONTEXT.md — iknow 领域词汇表

> 项目领域词汇的**单一事实源 (SSOT)**. 仅 `domain-modeling` 技能可写; 其他消费者按
> `docs/agents/context-contract.md` 消费.
> 本文件只收录**当前活跃术语**；完整历史版本保留于 git 历史.

---

## Language

**Loop Engine**: Foundation 的状态机运行内核，驱动模型 -> 工具 -> 真实结果 -> 下一轮模型 -> 明确停止；位于 `src/harness/`，作为 018 退役旧 loop 后的可靠运行时基础。
_Avoid_: 与旧 `IknowAgent` / `LlmIknowAgent` 混同；将泛称 "agent loop" 当作本项目术语

**append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。磁盘形态见 **session transcript**（JSONL 事件投影出当前头的 messages）。
_Avoid_: 任何 host 层第二份权威历史；任意形式的"编辑历史"

**session transcript**: 会话权威账本——单文件 append-only JSONL，每条事件有 id 与 parent；当前可见历史由 **rewind head** 投影，旧链保留。ADR-0027。
_Avoid_: 把 `SessionFileV1.messages[]` 当第二份权威；把 harness trace JSONL 当会话历史

**rewind head**: 落盘的当前头指针（transcript 某条事件 id）。rewind 只改这个指针，不截断 JSONL。进程内工作副本跟它走。
_Avoid_: 只在内存里 fork；用 `messagesCount` 当下标 SSOT

**continue_pending**: 截断后在**同一会话**把未完成的工具环接着跑完——先对人停住；用户再用 `/continue` 或（有 pending 时）续跑意图自然语言触发；不追加新任务 user message，先 sanitize 悬空 `tool_use`，再对已有 append-only messages 调用 `run`（#277）。匹配词表/策略属 spec；**不是** ACI 工具。
_Avoid_: continue 工具；把续跑口令一律当普通新 user 任务句；新建 session 挂旧历史；无确认自动续跑

**turnCount**: Foundation 运行时回合计数，每完成一个 assistant 回合（包括纯文本完成）加一；`maxTurns` 是在调用模型前检查的运行时上限。
_Avoid_: steps、retries

**stub model / stub tool**: Foundation 的确定性测试替身，覆盖真实模型或工具交通之外的完成、失败与停止行为；016 验 Gate A（S1–S11），017 起也验 Gate B required runtime layer（S12–S17 signal/timeout/trace），其中 `stub-signal-tool` 是 S17（ctx.signal -> AbortError -> execution_failed）的守门载体。不进生产装配路径。
_Avoid_: 声称已接入产品路径；mock agent、stub brain

**StopReason**: Loop Engine 的停止判别联合——016 五类（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse）末尾追加 017 的 `cancelled` 与 `timeout`，再追加 `fused`（本 run 工具环停滞，ADR-0029）；追加不重排，Transition 形状随之自动扩展。
_Avoid_: 把 cancelled 与 timeout 混为一条；把总耗时当作独立 stop 触发器；把 FaultClass 写进 StopReason；子代理把 fused 当成功

**FaultClass**: 并行于 StopReason 的失败策略闭集 `retry` | `fuse` | `none`（轴：API / 工具 / 上下文 / 控制流）；只决定传输重试与是否计入工具环，不回答 run 为何停。ADR-0029。
_Avoid_: 与 verify 失败签名混名；与工具四 kind 混名；塞进 StopReason

**tool-call loop detection**: 本 `run()` 内，工具阶段结果已追加进 append-only messages 之后、下一次 adapter.step 之前，用调用键与结果键做周期（k=1..5）重复 R=5 且停滞则 trip。ADR-0029。
_Avoid_: 连续 N=3 简化；verify 趋势停；sandbox violation kill；正文复读检测；settle 前取消同波 tool_use

**LOOP_DETECTED envelope**: 环检测 trip 时追加的固定模板 user 消息，写入权威 messages 并落盘，下一问作为 priorMessages 进模型；对人至少经 `stop=fused` 可见。
_Avoid_: 只 toast 不进历史；下一轮不喂模型；当成 tool_result 吞掉真实失败

**LoopTrace**: `run()` 的第二返回面 `{ result, trace }`（TurnTrace / Totals 两型）—— A 层结构元数据 trace（每回合 supplierStop / toolCall kind / durationMs / cancelKind + 一次性 reduce 的 totals），严格不含 payload；与 append-only messages 唯一权威解耦，immutable 累积。`cancelKind` 是取消来源四值枚举 `"none" | "callerAbort" | "timerTimeout" | "hostCancel"`.
_Avoid_: 在 trace 里塞 input/output/token/cost（B 层字段）——该禁令仅对 LoopTrace 本体，不外延到 TraceService（`LlmCallRecord` 承载 token usage 是 ADR-0008 裁决的合规落点）

**usage (token accounting)**: LLM API 每次成功调用回传的 token 计费（`inputTokens`/`outputTokens` 必填 + `cacheCreationInputTokens`/`cacheReadInputTokens` nullable，对齐 SDK `Usage`）；权威落点 = TraceService `LlmCallRecord`（观测真值，错误分支整条缺席），运行时暴露面仅 `RunResult.lastUsage`（TUI 显示读者，017:67 的有记录例外）。chars/N 估算只供压缩决策，永不进核算 / 显示（ADR-0008）。
_Avoid_: 用估算值顶替 trace 真值；为无读者的账本建运行时承载面；把 usage 塞进 LoopTrace

**context usage (display)**: 上下文用量显示 = TUI `ContextBar`（`src/tui/context-bar.tsx`）+ Web `ContextUsageStrip`（`web/src/components/ContextUsageStrip.tsx`）共同消费 `RunResult.lastUsage`（ADR-0008 D5）；wire 字段 = `TurnAnswerDto.lastUsage?` + `HealthResponse.contextWindow`（`src/session-api/` 投影，web 镜像于 `web/src/api/types.ts`）。百分比分子 = `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`（Anthropic 三类 token 互不相交）；分母 = `contextWindow`（来源 `env.compress.contextWindow`，env var `IKNOW_MODEL_CONTEXT_WINDOW`，默认 200000）。Running 时显示上一次已完成的 lastUsage（one-beat lag）。
_Avoid_: 用 chars/N 估算顶替 lastUsage 真值；为显示引入第二份 token 账本；让 contextWindow 走 `deps.compress`（避免触发 auto-compaction 行为变化）

**viewport mount**: ChatView 只把 scrollbox 当前视口加 overscan 内的 transcript 条目挂进 OpenTUI 树；滚动文档仍覆盖全量 `session.messages` 与方案 B banner，高度来自布局实测。
_Avoid_: 固定条数尾窗；行账 / 行窗口；把 LLM `/compact` 当 UI 树裁剪

**fence display cap**: TUI markdown 围栏在 OpenTUI 树上只挂前 32 行，溢出用 `还有 N 行`；会话正文仍是全文。与 write/edit 完成态 6 行预览窗分开。
_Avoid_: 用只挂最近 N 条消息代替围栏截行；把围栏窗改成 6；为省树而删 session 里的代码

**streaming block freeze**: 会变长的那串 markdown 里，除最后一个顶层块外钉住，后续增量不再 lexer、不再重建前缀子树；边界只前进。
_Avoid_: 把历史消息 memo 当成同一件事；每个新字整篇重解析；冻结时放开围栏 32 行窗

**ToolExecutionContext**: Executor 透传给 handler 的执行上下文 `{ signal }`；run 第三参 signal 原样透传、不创建子 signal，超时由 Executor `Promise.race` 外包而非 ctx 携带。
_Avoid_: 在 ctx 里放 timeoutMs；为每个 handler 建子 AbortController

**in-flight closeout**: abort/timeout/进程死亡时的收尾——live：模型在途则整回合不进历史；工具在途则 assistant 已追加，在途 tool 填 `execution_failed`（`"cancelled"` / `"timeout"`），再编码为 tool_result。signal 优先于 timeout。resume/load：未配对 `tool_use` 填 `"process"`（`InterruptReason` 预留档），**不加** `Interrupted by user.`；mutating 工具须指示先检查副作用再重跑。一律走现有 `encodeToolResults`。
_Avoid_: 回滚已追加的 assistant 回合；悬空未回填的 tool call；把进程死亡当成 cancelled

**required runtime layer / conditional remediation layer**: 017 的两层对仗边界——required runtime layer（signal / timeout / trace / cancelled-timeout 停止 / in-flight closeout）已实施；conditional remediation layer（自动重试、checkpoint 落盘、token-cost 护栏、trace B 层字段、工具分类超时、错误分类细化、总耗时独立 stop、OTel 导出）017 显式禁止，推迟到 018 真实接通后按 013 条件式修复原则补。
_Avoid_: 把 conditional remediation layer 提前带入 Foundation 内核；用禁词扫描注释/JSDoc 代替可执行面能力边界（checkpoint 落盘在 session-api）

**executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段，executor 永不信任工具声称的截断字段（防 MCP 第三方伪造绕过封顶）。#140 裁决，ADR-0004 / ADR-0006。
_Avoid_: 工具自填 truncated/total 字段；executor 凭工具标记跳过兜底截断

**plain-string tool output**: (契约 Y1, deprecated→#298) 原生产工具输出为纯字符串（wire 边界同形态）；bash 例外保留 `{code, stdout, stderr}`（Y1b）。#298 起 Y1「纯字符串」读法被 observability side-channel 取代——model-facing tool_result 仍纯字符串（Y1 精神保留），但 handler 可返 envelope `{ output, meta? }`，`meta` 走观测旁路，永不进模型视野。#140 裁决，ADR-0004。
_Avoid_: 工具自填 structured metadata 进 model tool_result；把 bash 例外推广到其他工具

**observability side-channel**: (#298) 工具观测旁路——handler 返 envelope `{ output, meta? }`；executor 拆分后仅 `output` 字符串化进 model-facing tool_result，`meta`（典型如 edit_file/write_file 的 `oldContent`/`newContent`）经 `PostToolUseHook.payload` → `TuiToolEvent.payload` → `LiveToolRun` 字段供 TUI diff 预览等观测消费者，永不进模型视野。ADR-0004（supersede Y1）。
_Avoid_: 把 meta 拼入 model tool_result；让 TUI / Web 直接读 handler 原始返回对象

**web_search backend selection**: `web_search` ACI 工具的后端选择面——按 `WebEnv.searchBackend` 显式选定（默认 `"bing"` / `cn.bing.com/search` HTML）；keyed backend 缺 key / 占位符解析失败 / backend 未设但 keyed key 已设一律 typed ToolExecutionError，无静默降级；零 key 默认路径与既有 Bing HTML 行为字节级一致。`specs/pluggable-web-search-backends.md`。
_Avoid_: 把 "fallback" 与 "default" 混名（无 fallback）；让 keyed 失败时静默降级到 Bing；把 backend 字段塞进 settings.json（非 LLM 字段走 env 链，不进 settings 单承载，ADR-0015 §5）

**search backend adapter seam**: `web_search` ACI 工具的可插拔 HTTP 后端接缝——同文件 `BACKENDS: Record<SearchBackendId, SearchBackend>` 表 + `selectBackend(id)` 分派；每家 adapter 投影到 Bing-shape `{title, snippet, url}`，T2 字段 cap 一刀切；v1 仅 Exa 真 HTTP，Tavily / Brave schema 占位（`fetchResults` 抛 typed `not_shipped`）；handler envelope `{output, meta?: {adapter, latencyMs, requestId?}}` 走 observability side-channel（v1 因 executor `isEnvelope` 白名单未扩，meta 通道推迟）；非 bing backend 拒 `search_url` 覆写。
_Avoid_: 给每家 adapter 写自家 field cap；让 keyed key 解析失败改 silent empty；让 TUI/Web 直接读 handler 原始返回对象（破 observability side-channel）；不查 backend 就读 key

**ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。可分析代码的默认发现与符号级修改见 **符号主路径**（ADR-0038）。
_Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组；让工具返回结构化 metadata；把坐标 `lsp_*` 当代码导航主 API

**符号主路径**: 智能体对可分析代码的默认工作方式——按 **符号身份** 查找并做符号级修改；`grep` / `read_file` / `edit_file` 只用于非代码、未知名字、语言服务器不可用，以及非单一符号的文本补丁。ADR-0038。
_Avoid_: 先全文搜索再对行列问语言服务器当主路径；坐标工具与符号工具长期双暴露给模型

**符号身份**: 指向源码实体的稳定键：文件内符号树路径（如 `ClassName/methodName`）加上相对项目根的文件路径，而不是行号列号。
_Avoid_: 把 1-based line / character 当模型主入参；把 grep 命中行当成符号键

**使用规则**: `deps.system` 中独立于 identity 卡片和 soul 的代码锁死段（装配名 `usage`），规定何时用符号工具、何时才 grep；四入口恒在（含 ask）。落点建议 `src/harness/identity/usage.ts`，与 `identity.ts` / `soul.ts` 并列。ADR-0038。
_Avoid_: 把工具路由写进 soul Vibe；只靠 AGENTS.md 承载这条纪律；把使用规则当成身份 Name/Kind/Signature

**声明工具面 vs 实际工具面**: `SubAgentDefinition.disallowedTools` 写进 `WorkerEnvelope` 的是声明面；worker 进程装配后真正可被模型调用的工具集是实际面，二者必须相等——裁剪发生在 `createAciRegistry(tools)` **之前**的 def-list 期（`createDefaultAciRegistry` 工厂内），由构造期快照保证，不事后修补（`AciRegistry.inner` 是冻结快照）。
_Avoid_: 给 `AciRegistry` 加 `.tools` 字段在产物上事后裁剪；声明 deny-list 但 worker 不消费（#468 修复对象）

**deps.system injection seam**: Each-turn 系统文本装配的唯一权威缝——loop-engine 调 `deps.system?.()`（`loop-engine.ts:358`），结果透传 `adapter.step request.system`；`undefined` 时不发送 `system` 字段（`anthropic-adapter.ts:577-580` 条件 spread），KV cache 前缀字节级稳定。装配主体是 `identity/assemble.ts` 的 `IKNOW_ASSEMBLY_ORDER` 流水线（#196）。
_Avoid_: 在 adapter 或 host 层直接拼系统；发送空串 `system`（KV cache jitter）；绕开 `deps.system` 在 adapter 内部二次组装

**memory_layer slot**: #196 9 段流水线 slots 5-9（user AGENTS / `PRIORITY_DECLARATION` / project AGENTS / `EXISTENCE_POINTER` / 可选 **memory_catalog** / promote 段）收敛后的单 slot 名，位置仍在 bootstrap 之后；委托 #121 `createSystemResolver`（`memory/refresh.ts`：mtime 缓存 + inflight 去重 + 装配失败不毒化缓存），内部拼接顺序由 ADR-0009 锁定，目录段由 ADR-0034 追加。#228 决议 D2。
_Avoid_: 逐 slot 独立消费缓存；再拆拼接后的整串；把拼接顺序拆出 slot 边界独立决策

**surface split (identity vs memory)**: 入口面（`chat` / `tui` / `ask` / `serve`）的两层语义——身份认知层（`identity` / `soul` / **使用规则** / `user_profile` + 仅对话入口触发的 `bootstrap`）恒在；记忆层（`AGENTS.md` + rules + 记忆库 + `memory_recall` / `memory_save` 工具）只对 chat / tui / serve 装配，`ask` 全 opt-out（`memory_layer` slot 不挂、memory 工具不入注册表）。#228 决议 D3；usage 段 ADR-0038。
_Avoid_: `ask` 全 opt-out（破"我是谁"答复路径）；`ask` 全 opt-in（破 #121 "ask 无状态"前提）；按 surface flag 同时决定两层；ask 去掉使用规则

**auto_extract**（`settings.memory.autoExtract`）: 自动记忆抽取的产品总闸，boolean-only、**默认 OFF**——段缺失或非 `true` 一律关抽取与 **promote** 装配。`true` 时 host 仍按 N≥2 抽，且梦境双闸满足时必跑梦境 LLM（即使 `settings.memory.dream === false`）。仅当 extract 与 dream 均关时 `BuiltEngine.autoMemory` 缺席。ADR-0031 D1/D5；分层 `specs/auto-memory-layering.md`；钩子见 ADR-0033。
_Avoid_: 把默认改成 ON；开抽取却不要梦境；关抽取仍拼 promote 段；把抽取 prompt 内嵌进 loop-engine；给 `ask` 接线；让 ingest 失败冒泡成用户 turn 失败；开抽取却不注 memory_catalog

**memory_op**（`ADD` | `UPDATE` | `SUPERSEDE` | `NOOP`）: persist 仍认四态；**抽取** `decide ops` 只用 ADD / 保守 UPDATE / NOOP（无 CONTRADICTION_FLOOR SUPERSEDE）。`SUPERSEDE` 由梦境 `replaces` 点名后 persist 写出 `supersedes`，旧条仍经 **memory_gc** 软禁。三段函数分离不变。ADR-0031 D2 修订；`specs/auto-memory-layering.md`。
_Avoid_: 抽取再用低词重叠当矛盾作废；把四态压成 upsert；绕开 `memory_save` 写纪律；把三段合成一个函数

**memory_gc**: 可重复、幂等的机械清理，三条规则、**零 LLM**——`ttl_days > 0` 且已过期 → `disabled: true`；被别的条目 `supersedes` 指名 → `disabled: true`；活跃条目超 store cap → 按效用分 `importance × recency × (1 + recall_count)`（recall 次数取自既有 `usage.json` sidecar）从低到高软禁。GC **只软禁不删文件**，误驱逐改一行 frontmatter 就能收回。ADR-0031 D4。
_Avoid_: 硬删文件；把 LLM 离线合并 / 摘要塞进 GC（合并走 **dream**，ADR-0033）；让 GC 依赖 frontmatter + usage sidecar 之外的运行时状态

**memory_type**: 事实条目 frontmatter `type` 的封闭枚举：`convention` | `decision` | `gotcha` | `constraint` | `note`。手动 `memory_save` 与自动 ingest 同一套；空或非法值收成 `note`，不 fail 写入。`specs/memory-layer-follow-ups.md`。
_Avoid_: 自由字符串当 type；自动与手动两套词表；非法 type 整次写入失败

**source: auto**: 自动写入条目的 provenance 标记，落在 frontmatter（`sanitizeMemoryFile` / `serializeMemoryEntry` 已 round-trip 未知字段，无需 schema 升版）。自动条目**只经 `memory_recall` 的 tool_result 与 memory_prefetch 用户侧块**到达模型（低信、常过时），永不把未 promote 的 body 盲注 `system`（ADR-0009 D3 / ADR-0034）；也不豁免 promote 门槛，仍需 ≥2 个不同 session 的 recall，没有 auto-promote 路径。该标记同时是批量回退的抓手。ADR-0031 D3。
_Avoid_: 给高 importance 的自动条目开 auto-promote；把 `source: auto` 当成信任等级之外的纯装饰；用别的字段区分人写 / 机写；把自动条包装成必须遵守的规则

**memory_catalog**: 现行条短目录（title + 一句钩子），在 `autoExtract === true` 且库非空时进入 `system`（EXISTENCE_POINTER 之后），带固定英文纪律句。不是条目 body，不是 promote 段。上限 200 行 / 25KB。ADR-0034。
_Avoid_: 把目录当全文记忆；抽取关闭时仍灌目录；用中文写纪律句

**memory_prefetch**: 每轮按本轮用户原文、用 `scoreMemoryEntries` 选出最多 5 条现行条正文，叠在用户消息侧；零词命中不得入选；包装句英文、标明 advisory；禁止写入 system。会话级按 id 去重：一条记忆一个 conversation 只注入一次，首轮块随 user turn 留在历史（append-only，不 strip，保 KV cache 前缀），resume 扫历史 `id:` 行恢复去重集合，失败容忍一次重复、不 fail turn。ADR-0034；去重契约 `plans/auto-memory-prefetch-dedup.md`。
_Avoid_: 把预取写进 system；每轮硬塞满 5 条无关条；预取另起一套打分；会话内每轮重复注入同一条；strip / 改写历史里的旧 overlay（破 KV cache 前缀）；给 `ask` 接线

**dream**（`settings.memory.dream`）: LLM 离线合并开关，boolean-only、**默认 OFF**。闸仍 24h ∧ 5 session。`autoExtract === true` 时闸到后仍跑梦境（不必 `dream === true`）；输出可带 `replaces`，persist SUPERSEDE，不经 CONTRADICTION_FLOOR。闸文件 **dream.json**。其余（skip 推进时间闸、`source: dream`、不进 `gc.ts`）仍见 ADR-0033。
_Avoid_: 把合并塞进 GC；每 turn 强制 dream；与抽取共用 N≥2；默认 ON；dream 条 auto-promote；用 CONTRADICTION 代替 `replaces`；闸文件名含 cursor

**source: dream**: dream 合并写入条目的 provenance 标记，落在 frontmatter（未知字段 round-trip，无需 schema 升版）。与 **source: auto** 同通道：只经 `memory_recall` 的 tool_result，永不盲注 `system`，不豁免 promote。批量回退按 `source: dream` 抓。ADR-0033。
_Avoid_: 与 `source: auto` 混用导致无法区分抽取与合并；dream 条 auto-promote

**dream.json**: 每个 `memoryDir` 下梦境双闸状态（上次成功或 skip 时间 + session 集合）。实施读写此文件名；不读、不迁 `dream-cursor.json`。
_Avoid_: 文件名含 cursor / Cursor；旧名兼容层

**memory archive**: 热目录外的软禁归档（`memoryDir/archive/<slug>.md`）。召回 / 预取 / 抽取近邻 / 梦境输入 / cap **不扫** archive；不是硬删。
_Avoid_: 把归档当硬删；热扫描仍遍历 archive

**chat REPL** / **product CLI**: TTY interactive `iknow chat`（或裸 TTY invoke）的人类视图；管道模式为串行非终端 turn。
_Avoid_: 把 one-shot JSON `ask` 当作交互产品；管道上 `terminal: true`；空 `ask` 时塞默认 demo query

**oneshot / ask**: 脚本/CI 路径：单次问题 -> JSON on stdout；空 query -> usage + exit 1。
_Avoid_: 空参数时塞中文 demo query

**Session HTTP API** / **session-api**: Host 多会话面（`src/session-api/`，`node:http`）：create / message / command / reset；每条 message 返回 JSON；非 tool schema。
_Avoid_: 在 Session API 之外另起前端直连；把 harness 工具逐一包成 REST

**legacy archived/invalid session**: 遗留 session file 缺少或包含非法 `workspaceRoot`（包括路径边界校验失败）的分类；load/list 可以暴露该分类，但 execute 必须在 engine 前拒绝，并提示 recreate 或 bind。该分类不允许通过 cwd 回填恢复为可执行 session。
_Avoid_: 把 legacy unbound 当作正常兼容态；静默迁移；把 archived/invalid 当成已删除

**Hub dirty root**: SessionHub 按 `conversationId` 持有的待持久化 session-root rebind；仅当 harness provision 返回不同根时记录，conditional save 成功后才清除。它是保存协调状态，不是第二份 workspaceRoot 权威。
_Avoid_: 每次 provision 都标 dirty；保存失败先清除 dirty root；让 cli/tui 绕过 Hub 直接写 session file

**Hub-visible provision seam**: harness isolation 的既有 provision 契约经 SessionHub 可观察的接缝；Hub 只观察返回根并维护 dirty root，不改变 harness 的 provision contract，也不把 session worktree 变成 serve 多根。
_Avoid_: 在 TUI 私有路径另起 provision；把 harness isolation 当 product workspace 选择；让 provision 失败静默回退

**iknow serve**: CLI host，跑 Session API + 静态产品 UI（`web/dist` 优先，回退 `web/`）。
_Avoid_: 把 frontend-only server 当生产路径但不代理 `/api`

**workspace（serve 主根）**: serve session 的产品项目根，来源可以是 product SPA 选定的已存在绝对目录、显式 flag/env，或当前 serve 的显式默认绑定 `<homedir>/.iknow/default`；绑定后三锚合一。ADR-0023：serve 不把进程 cwd 当作隐式主根。
_Avoid_: 把 serve 缺省说成 `process.cwd()`；与 `workspaceRoot` 字段、`home`（global 配置锚）、`sandboxRoot` 混同

**workspaceRoot**: session 绑定的 per-root 操作状态锚（memory / sessions / tasks / settings 写回 fallback / serve data）；配置解析器仍可按 ADR-0019 D1.1 以 `process.cwd()` 生成默认值，但 session 创建前必须把解析值校验并明确写入。serve 无 flag/env 时的默认绑定值是 `<homedir>/.iknow/default`。不含用户画像。画像根见 ADR-0025。
_Avoid_: 用 workspaceRoot 当 `user.md` / `BOOTSTRAP.md` / 用户级 `AGENTS.md` / 用户 `rules/` 的物理根；把 identity seed 跟启动目录绑在一起

**required workspaceRoot**: 新 session 创建时必须存在且通过校验的绝对 `workspaceRoot` 绑定；`cli chat`、`tui`、`serve` 都不能写入没有该绑定的 session file。执行阶段若绑定缺失或非法，必须在 engine 之前拒绝。
_Avoid_: 把 resolver 的默认值当成已写入的 session 绑定；用 `process.cwd()` 回填缺失字段；把 serve 的 `~/.iknow/default` 默认绑定称为 unbound

**user.md**: 全局用户画像，唯一落点 `~/.iknow/user.md`（测试缝 = `userHome/.iknow/user.md`）；每 turn 注入 `user_profile` 段，改文件下一轮生效。ADR-0025。
_Avoid_: 项目 `.iknow/user.md`；per-root persona；把画像当成 workspace 状态

**user-level AGENTS.md**: 对所有项目生效的行为约定，物理根与 `user.md` 相同（`~/.iknow/AGENTS.md`，测试缝 `userHome/.iknow/AGENTS.md`）；同根 `~/.iknow/rules/*.md` 按文件名拼进用户静态层。项目 `AGENTS.md` 叠在其上，冲突时项目优先（ADR-0009）。`specs/memory-layer-follow-ups.md`。
_Avoid_: 把 `<workspaceRoot>/.iknow/AGENTS.md` 当作用户级层；把用户级 AGENTS 和项目记忆库 `.md` 条目混成一种文件

**BOOTSTRAP.md**: 首启引导种子，与 `user.md` 同根（`~/.iknow/BOOTSTRAP.md`）；文件存在则注入 bootstrap 段，agent 删除该文件即完成。`state.json.bootstrap_seeded` 只防止重复 seed，不是完成条件。
_Avoid_: 每个仓库一份 BOOTSTRAP；用 workspaceRoot 下的 BOOTSTRAP.md 当引导；把 bootstrap_seeded=true 当成「用户已填完画像」

**unbound**: 没有可校验 `workspaceRoot` 的过渡或遗留无效状态，不是正常产品状态。创建必须拒绝；execute 必须在 engine 前 typed reject；legacy session 进入 archived/invalid 分类。serve 当前无 flag/env 时绑定 `<homedir>/.iknow/default`，不属于 unbound。
_Avoid_: unbound 时 buildHarnessEngine 或 postMessage；把 unbound 说成「默认 cwd」；用 cwd 回填 legacy session

**product SPA (web/)**: Vite + React + TypeScript chat console；同源 Session client；JSON 侧栏。
_Avoid_: 零依赖静态壳当产品；展示层省略 trace 字段

**正常模式**: 默认 HITL 产品：每轮说完把回合还给用户；完成向 LLM 关闭；硬失败打回干活模型。
_Avoid_: 每个 completed 请 LLM 评「做完没」；先问有没有 goal 再决定怎么判；把正常模式当成「没开 goal」的别名

**自动模式**: 权限轴 `PermissionMode` 的 `full_auto`：本轮 mutating 不问人，跑完仍把键盘还给用户。Shift+Tab / 徽标上的 Auto 就是它。ADR-0032。
_Avoid_: 把 `/goal` 续跑叫自动模式；全自动模式；第三种 PermissionMode

**goal 功能**: 斜杠钉上会话使命后的续跑：`/goal <text>` 写入后 hub 用 `goal.text` 接着跑，直到条件成立、判官 Impossible、不可恢复错误、可选轮次上限或 `/goal clear`；空转停循环但 goal 可留着。不是模式，不进 Shift+Tab。ADR-0032。
_Avoid_: 自动模式；全自动模式；`## GOAL:` 当产品入口

**goal（会话使命）**: goal 功能的完成条件，只由 `/goal <text>` 写入（`source = user_pin`），仅 `/goal clear` 或停档清掉；钉上即跑 goal 功能续跑。
_Avoid_: `## GOAL:`；钉上叫进入自动模式；`goal.text ?? query` 当验收任务；把 goal 当模型可推进的活对象；模型输出 / 工具结果 / 文件内容写 goal

**一轮**: 用户一句交代之后、模型做到把控制权交还用户为止；其间可含多次工具循环，落成多条 `messages`。
_Avoid_: 把一条 `tool_use` / `tool_result` 当一轮；把截断窗口的条数当成「留几轮」

**截断窗口**: compact 从 `messages` 末尾留下的原文条数（计 message 对象，不是轮、不是字数）；窗口内若有 `tool_result` 而对应 `tool_use` 在窗外，再把那条 `tool_use` 整条捞回。
_Avoid_: 按 token 或字数切窗；拆开一对 `tool_use`/`tool_result`

**任务摘录**: 仅 compact 发生时从当时 `messages` 现抽现贴的最近至多 3 句合格用户任务原话；不进会话字段；goal 功能续跑时不贴。
_Avoid_: taskFocus；当前任务卡；每回合或压缩时让 LLM 填卡；把摘录自己再抽成用户任务句

**状态栏**: 每次即将调模型前由 harness 算出的现势，以 **user** 消息追加在 `messages` 末尾（含同一用户回合内 tool loop）；旧栏留在历史上，不替换、不写 `deps.system`；UI 只读同一份，in-flight 只给 TUI。字段仅 `last_tool`（本回合尚未跑过工具则为 idle）以及有未勾项时才出现的 todo 段（只投影 `- [ ]` 行；文件缺席 / 空 / 全勾则整段缺席）。ADR-0028。
_Avoid_: 每轮替换/删除旧栏；写进 system；把 TUI 当主物；与 context usage (display) 混名；让 LLM 维护栏；把栏接入 verify；每跳塞任务摘录/cwd/技能清单；把调模型时的 in-flight 写进栏；taskFocus / 当前任务卡；空清单仍印 todo 段；全勾后栏里带 `- [x]`；用「本跳是否调用过 todo_write」当在场条件；政策散文进栏；把 **环境现势**（cwd/git/diff）塞进本栏

**环境现势**: 给人看的工作区快照（至少 cwd / git 摘要 / diff 要点），投放在 TUI（或等价）人读面；**不**写入 ADR-0028 状态栏 user 消息，也**不**充当 verify 输入。#655（G1）验收画像锁定。
_Avoid_: 状态栏；agent-status；把 cwd/git/diff 每跳追加进 `messages`；与 context usage (display) 混名

**沙箱纪律**: 同一 `bash` 调用输入下，前台执行与 `background:true` spawn 共用同一套 bwrap 围栏参数（FS / 网络 / env 隔离 / rlimit / cwdReadonly）；产品路径不得提供无围栏的后台裸跑。#653 G3。
_Avoid_: 把后台当成逃出 bwrap；与 #440 bash 产品面混名；与 spawn_subagent 前景/后景混名

**compact reason**: 触发判据返回的分类标识，取值 `below_token_threshold` | `messages_too_few` | `windowed` | `full_summary`，单源 `src/harness/compress/index.ts:evaluateCompactTrigger()`；手动 `/compact`（hub.compactSession）与 loop-engine proactive 两条路径共用同一函数返回值，决定 UI 文案分支与 wire 字段（`CompactSessionResponse.reason`）。
_Avoid_: 「未达阈值」「压缩成功」等 UI 字面字符串直接出现在业务代码；reason 字面量在 hub/loop-engine 多处内联（应经 `compactReasonFor` SSOT helper）；把 reason 错放成 `LoopTrace` / `LlmCallRecord` 字段

**auto-compact token gate**: proactive compact 在每轮 step 前的 token 阈值判据，公式 `contextWindow − MAX_OUTPUT_TOKENS_FOR_SUMMARY − AUTOCOMPACT_BUFFER_TOKENS`（值见 `src/harness/compress/threshold.ts`），显式 `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` 可覆盖；与手动 `/compact` 共享同一函数 `evaluateCompactTrigger`，token 估算仅参与判据决策，**不**进 trace / `RunResult.lastUsage`（ADR-0008 D6）。
_Avoid_: 把字符估算（`estimateMessagesTokens`）当作真实 token 用；gate 决策绕开 `evaluateCompactTrigger` 直接调 `shouldAutoCompact` 旧接口；把 threshold 当成「每机配置」（应是项目栈决策）

**task 取值公式**: 无统一 `??` 链。goal 功能判官 `task = goal.text`（无 fallback）；正常模式不设完成向 `task`。
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

**host drain**: host 把 completed 子代理的父可见信封浓缩成一条带固定前缀的消息、拼进下一次 `run()` 的 priorMessages；只读 buffer、不改状态。后景臂下：已有终态则立刻浓缩；仅 running 则立刻空返。叫醒主模型靠 mailbox，不靠用户再打一行，也不靠在 `run()` 边界空转等待。
_Avoid_: 把 drain 与"结果获取"混同（前景 spawn 不经 drain）；让 agent 侧直接消费 manager buffer；把 drain 被动挂"下一轮用户输入"或阻塞轮询当作可靠唤醒源

**mailbox**: 后景 spawn 的子→父终态回传通道。只投终态浓缩结果，不承载运行中消息，也不是子↔子协议。
_Avoid_: 进度流；swarm / 子代理互投；把 mailbox 当 D-δ 低层 messaging

**父可见信封**: 子代理交差给父模型看的那一层——短摘要、改过的路径、成败与停因；不是终稿全文，也不是磁盘上的代码。
_Avoid_: 把完整 result 当任务产物；把汇报截断当成任务失败

**子代理并发上限**: 同时处于 starting/running 的 worker 硬顶，可配、默认 15；发几张由模型决定，超限立即失败、不排队。
_Avoid_: 静默排队；让用户每次填写要派几个

**子代理根归属**: 子代理是**父会话的执行臂**，继承父会话当前生效根；不是独立隔离单元。父会话已 rebind 时与父共享同一棵 task worktree；manager 层用父 `conversationId`，worker/LoopEngine 层用自己的 `conversationId`。父会话尚未 rebind 时，满足只读门禁的子代理可留在主仓，但不创建独立 worktree。ADR-0040。
_Avoid_: 每个子代理单独建 worktree；把子代理的 worker `conversationId` 当成父会话路由 ID；把主仓只读放行误读成独立根

**派发门禁判据**: 按**有效工具面能力**推导，**不按角色名匹配**。两维同时成立才允许留在主仓只读运行：(1) 有效工具面不含 `write_file` 也不含 `edit_file`；(2) 有效工具面不含 `bash`，或该角色 `bashMode === "readonly"`。任一维不成立即判为会写；未知角色 fail-closed 判为会写。ADR-0040。
_Avoid_: 用角色名白名单代替能力判定；把父代理 `disallowedTools` 当成 `bashMode` 覆盖；未知角色默认放行

**说明书静态层**: 用户级与项目级 AGENTS.md 及 rules，可注入通用 worker 的 system；与记忆工具、自动抽取、记忆库灌窗分开开关。
_Avoid_: 用 memoryEnabled 一把关掉说明书；把说明书和 memory_recall 绑死

**说明书读法**: 说明书（rules）的发现与装载纪律——用户级 `~/.iknow/rules/` 与项目级 `.iknow/rules/` 目录缺失或为空**视为空集、不 fatal**（worker 不得因缺目录退出，不要求操作员先 mkdir）；父会话（chat / tui / serve）**不把全部 rules 正文灌入开场上下文**，模型按需用读路径打开具体 rules 文件；干活 general-purpose 子代理开场注入**已存在**的 AGENTS.md 与 `.iknow/rules/*.md`；explore 子代理不注入项目说明书正文；硬约束仍走权限层（`.iknow/permissions.toml`），不搬进说明书正文。ADR-0009 D2 的 amended 读法（2026-08-30）。
_Avoid_: 缺目录 fatal / `scandir` ENOENT 让 worker 退出；父会话开场整段灌 rules 正文；把硬约束从权限层搬进说明书；explore 注入说明书正文；把「按需读」读成「永不注入」（general-purpose 子代理开场仍注入已存在文件）

**graph mode**: 会话级编排 overlay，不是 PermissionMode。Shift+Tab 三态轮 `Default → Auto → Graph → Default`（`/graph` 为非 TTY 对等物）；进 Graph 后**下一次 `run()` 装配**才注入编排段并露出 `run_graph`，过程中切换不拦、不中途重装配。ADR-0030。
_Avoid_: 第四种 PermissionMode；把 `src/harness/graph/` 写进 prompt；env gate 才注入；进图改 ask/auto；切模式当下 round 热替换工具面

**run_graph**: 仅 graph mode 打开时装配的 ACI 工具——父代理声明 DAG，host 走 `validateGraph` → waves → `createSubAgentNodeExecutor`；图节点仍是前景 spawn。默认模式不装。
_Avoid_: 与 spawn_subagent 混名；默认任务进图；模型 import graph 模块

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

**判官（judge）**: 共用的只读 LLM 分类器系统（四态；内环 `maxTurns: 2`）；完成向评价只挂 goal 功能逻辑模块。
_Avoid_: 另起一个 goal 专用判官产品；command 缺失就当总开关每轮请判官；给判官执行能力；与 evidence-checker 混同

**checker 三态 verdict**: 证据充分性判定 = `EVIDENCE_SUFFICIENT` / `EVIDENCE_CONTRADICTED` / `EVIDENCE_INSUFFICIENT`；6 条检查封装在 `evidence-checker.ts` 内部。HITL 用它做硬失败/补跑；goal 功能里它只进 `evidenceContext` 当提示，绿了仍要 LLM 评 `goal.text`。
_Avoid_: 与闭环「三态判定」混同；调用方自数 PASS 条件；`SUFFICIENT` 当作 goal 功能已完成

**green marker**: 测试框架输出里的通过摘要行（白名单 pytest / jest / vitest / go test / cargo test）；checker 只从框架摘要行读通过数字。
_Avoid_: 扫描任意 stdout 判绿；白名单外自造框架解析

**弱绿（weak green）**: exit 0 但不代表整套过的绿——`0 tests run` / `collected 0 items` / `no tests found` / 窄跑（`-k` / `-t` / `::`）；弱绿不算充分证据。
_Avoid_: 把 exit 0 当测试通过

**unverified**: 判官第 4 态——判官工作正常，但读完证据后认为不足以判定完成，拒绝猜 PASS/FAIL；映射到 `unstable`（停止、不注入信封、结果原样返回用户），与 `abort`（判官自身 transport/schema/超时故障）严格区分，`VerificationRecord.reason` 落盘区分。
_Avoid_: 把 unverified 猜成 pass 或 fail（"a verifier that bluffs is worse than none"）；与 abort 混同

**evidenceContext（证据体检单）**: 判官信封独立字段（checker 三态、缺因、已跑命令、摘要，宿主截断 ≤ 20000 codepoints）；是提示不是考题，`SUFFICIENT` 不是 goal 功能 PASS 通行证。
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

**渐进式披露 (progressive disclosure)**: (#631) 便宜索引常驻 + 重载荷按需的两级披露——索引档（skill 清单 / `<mcp_tools_overview>` MCP 概览）每轮随 system prompt 在场，重载荷（SKILL.md 全文 / 工具完整 schema）经 `skill` / `tool_search` 按需拉取。iknow 机制 = lazy 注册 + `discover()` 命中 + `visibleSchemas` 组合（非 lazy 注册序前缀字节级不变 + discovered 按发现序尾部追加，保 KV cache 前缀）。
_Avoid_: 把发现的工具插回注册序中部（破 KV cache 前缀）；只延迟载荷不给索引线索；概览段发空串占位

**stderr 指针**: worker crash 取证三件套的落盘形态——`subagent_stop.error` 结构化字段 + `stderr_path`/`stderr_bytes` 指针字段 + `<traceDir>/stderr/<taskId>.log` mask 后全量文件；父可见 summary 只留尾部 ≤2000 字符预览。specs/trace-agent-readability.md。
_Avoid_: 把完整 stderr 内联进 JSONL 行；stderr 落盘绕过 SC20 mask；把 summary 截断当成诊断丢失

**blob 引用模式**（`IKNOW_TRACE_MESSAGES=blob`，默认 `full`）: llm_call 行内 messages 元素替换为内容寻址引用 `{sha, bytes}`、正文写 `<traceDir>/blobs/<sha>` 的 opt-in trace 存储模式；`messages_captured` 捕获语义不变，物理去重（实测 98.2% 重复）。ADR-0036。
_Avoid_: 默认开启；当成对 ADR-0014「模型实际所见」不变量的修订；与写侧 delta/off 截断混同

**tool_result projection**: 从已解引用的 `llm_call.messages` 抽出的工具结果摘要（`tool_use_id` / name / is_error / chars / preview）。供 `query_trace` 列表与下钻；**不是** `tool_call` 行上的 stdout 副本。`specs/query-trace-tool-results.md`。
_Avoid_: 打开 `resultCaptured` 往 tool_call 抄正文；把投影当会话账本；默认下钻倒 messages 全文

**crash 取证无条件**: `subagent_spawn`/`subagent_state_change`/`subagent_stop` 生命周期事件与 stderr 指针文件在所有产品入口（含 chat REPL）落盘，与主循环 content trace 的入口开关解耦。ADR-0035（对 ADR-0003 D10 的范围修正）。
_Avoid_: 把生命周期事件绑回 `--trace-out`；把该扩张理解为 content trace 进 chat REPL

**worktree isolation mode**（`settings.isolation.worktreeOnMutate`，默认 OFF）: 全局隔离开关——OFF 时会话行为与今日完全一致；ON 时会话可只读主仓（相对读路径不改写到主仓绝对路径），首次 mutate（写路径）被拦截——host **不自动** `git worktree add`——模型调用**创建工作树 ACI 工具**完成建 task worktree（含 task 分支）与 **session worktree rebind**，此后本会话 mutate 只进该根；已绑定则放行，不建第二棵树。工具成功后 Host 只保证路径已切：不同波重放被拦的写，由模型在新根上自己再调，不要求操作员 `/continue`。只在启动加载点读取一次；config 层不读 git、不持会话状态；改绑不隐式重载 project settings。建树/绑定失败与主仓非 git 仓库一律 fail-closed：typed 可见错误，不静默放行写主仓。task worktree / 分支名已存在 → typed 错误不覆盖。ADR-0037（amended 2026-08-30：建树由 host 自动改为模型调 ACI 工具；对 ADR-0023「worktree/多根只读推迟」的窄面 reopen；git worktree ≠ product workspace 多根）。
_Avoid_: 默认 ON；把 git worktree 混成 serve 主根或 `workspaceRoot` 多根；config 层读 git 或持会话状态；改绑后隐式重载 settings；建树失败静默写主仓；只建树不改绑会话；同名树静默覆盖；门禁自动 `git worktree add`；让 Host 同波代执行被拦的写

**创建工作树 ACI 工具**: worktree isolation mode ON 时模型可见的 ACI 工具三件面之一（create / enter / exit，均经 host 缝注入 build-engine 条件装配，worker / hub-less 工具面缺席）——创建本会话 task worktree（含 task 分支）并把当前会话根锚改绑到该树；内部走既有 provision 缝（**Hub-visible provision seam**），不另起建树路径。成功 = 树在且会话根已切到该路径；同名 task worktree / 分支 → typed 错误，不覆盖、不复用归属不明的树；失败 → typed 错误且主仓零写入。ADR-0037（amended 2026-08-30）。
_Avoid_: 让门禁自动建树；只建树不改绑；绕过 provision 缝另起建树路径；把工具失败当静默成功；对同会话并发建树不幂等

**enter-task-worktree（进入工作树工具）**: worktree isolation mode ON 时模型可见的显式进入工具——会话（锚在主仓）经 owner conversationId 进入一棵**本仓已存在**的 task worktree（含他人会话的树），目标路径由 SSOT `taskWorktreePath` 派生，**不收自由路径**。授权 = 持久锚：改绑的持久记录（`session.workspaceRoot` === 引擎 task-worktree 形状根）写明「该会话显式在此树上」，provision 据此 adoption 放行其 mutate——重启安全，无进程内状态依赖。目标不存在 → typed `worktree_not_found`；非本仓 linked worktree / 调用方已在树内 → typed `foreign_worktree`；成功仅改绑本会话，主仓零写入、树内容零污染。ADR-0037（amended 2026-08-30，issue #839）。
_Avoid_: 收自由路径当输入；无持久锚就放行外来树上的 mutate；把进入树会话的 session 文件改写当成改绑波及他人；让 worker 子代理获得该工具

**exit-task-worktree（退出工作树工具）**: worktree isolation mode ON 时模型可见的对称退出工具——无参数；会话当前 task worktree 保留不删（孤儿树自动删除是明确非目标），会话根回到主仓根（由树经 `git rev-parse --path-format=absolute --git-common-dir` 派生，重启安全）；经 dirty-root conditionalSave 持久化后下一回合门禁在主仓重新武装（拦写 + 指向建树工具）。当前未改绑 → typed `rebind_failed`，非静默 no-op。ADR-0037（amended 2026-08-30，issue #839）。
_Avoid_: 顺带删除树或分支；把 exit 当成静默 no-op；退出后同回合继续在旧树上写

**session worktree rebind**: worktree isolation mode ON 下模型调用创建工作树 ACI 工具、建树并改绑成功后，把**当前会话**的 `taskRoot` 切到本会话 task worktree 的动作（`productRoot` / `installRoot` 不动，ADR-0037 §4 amended 2026-08-31）；只影响本会话——不 checkout 其它会话 / 其它 worktree 的 HEAD，push / 开 PR 不拖动主仓或其它 worktree 当前分支。同会话并发建树幂等（一棵树、一个 task 分支）；父会话改绑后 spawn 的子代理继承该根，不另建树。ADR-0037。
_Avoid_: 改绑波及其它会话；把 rebind 当 serve 主根重绑（ADR-0023 unbound / recents 语义不变）；让 rebind 触发 settings 重载；顺带搬走项目身份或 per-root 状态；把改绑后的根错当成 product workspace 多根

**productRoot**: 每个产品入口首次装配确定的稳定主 checkout root；session worktree rebind 后保持不变，不随当前 task worktree 改写。`mcp.json` 只问它。项目身份改问 `projectIdentityRoot`（见该词条）；per-root 状态（记忆库落盘根 / tasks 登记）的锚仍是 `workspaceRoot`，仅当它自身已是 task worktree 时退到 `productRoot`（保住 `--workspace-root` 重定向，同时状态不落进树）。settings 锚在启动时解析的根，改绑不重载（ADR-0037 §4/§5 amended 2026-08-31）。

**projectIdentityRoot**: 用户此刻在做的那个项目根（今日 = 启动 cwd），宿主在启动装配 opts 里钉一次，session worktree rebind 只覆盖 `cwd` / `workspaceRoot`，本值不动。项目身份的唯一来源——rules / 项目 `AGENTS.md` / `permissions.toml` / 项目 skills 发现、子代理继承的身份根、记忆库命名空间名、`read_file` 在**隔离开且已改绑**时的主仓只读放行（开关 OFF 或未改绑都不放行，读沙箱与今日一致）。与 `productRoot` 分开的原因：后者被宿主取自 `workspaceRoot`，`--workspace-root <dir>` 重定向档下 `<dir>` 不是项目。缺席时退 cwd（hub 重建多一级：钉下的值 → `boundRoot` → `root`）；装配层对钉下的值与回退值一律套 `mainCheckoutOf`，身份根不得是 task worktree（在遗留树里启动时钉住空树会让身份整条消失）；它是会话根 SSOT 的第四个角色，空 / 相对值 typed fail-closed（ADR-0037 §4 amended 2026-08-31）。
_Avoid_: workspaceRoot；task worktree root；product workspace 多根；只当它是 MCP 配置根

**taskRoot**: 本会话当前的 task worktree root（创建 / 进入工作树工具切过去，退出工具切回主仓）；session worktree rebind **只切这一个根**。写与工具 cwd 只问它——写工具 / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录；项目身份与 per-root 状态一概不问它。ADR-0037 §4。
_Avoid_: workspaceRoot 兼当写隔离根；把它当记忆 / settings / 说明书根；往它上面 seed 一份 `.iknow`

**installRoot**: iknow 运行时自身的安装位置，worker bootstrap 由它解析 tsx 与 iknow 自身依赖（锚在 `import.meta.url`，不随会话根走）。与用户项目的 `node_modules` 无关，故裸 task worktree 上真 worker 仍能起。ADR-0037 §4。
_Avoid_: 用户项目 node_modules；taskRoot；子进程 cwd 相对解析

**mcpConfigRoot**: 由 productRoot 派生、跨 session worktree rebind 保持稳定的 MCP 配置根；只读取 `<mcpConfigRoot>/.iknow/mcp.json`，不切换到 task worktree。
_Avoid_: workspaceRoot；task worktree；process.cwd()

## Relationships

- **run() messages -> adapter streaming arm -> interpretMessage**: harness LLM path（流事件以 `HarnessStreamEvent` 经 `onStream` 暴露）
- **turn -> LoopEngine -> tool call -> result -> next turn**: harness 驱动；tool use 经 ACI permission middleware
- **Session HTTP -> run() -> AssistantTurnResult -> SessionHub**: session-api host 路径；messages 每回合投影到 UI
- **正常模式 vs 自动模式**: HITL 每轮还键盘 vs 权限 `full_auto` 本轮不问工具；goal 功能不是这一对
- **HITL 判官 vs goal 功能**: 两套判断逻辑模块，共用判官系统；不是一条 `goal ?? query` 链（ADR-0024 机制仍在，产品口不叫自动模式）
- **continue_pending vs goal 功能**: continue 是 HITL 同一会话 skip-append；`/goal` 钉着则拒绝（`goal_active`），禁止把 continue 当 goal 续跑的下一跳
- **自动模式 vs goal 功能**: 自动模式是权限；goal 功能是斜杠钉使命后的续跑。正交，可同时开
- **continue_pending vs in-flight closeout**: continue 只消费 `store.load` 的 closeout 投影补悬空 `tool_use`；不另写 sanitize 去删改 tool 对，也不把 closeout 本身当续跑口令
- **状态栏 vs context usage (display)**: 状态栏是给模型的现势快照；context usage (display) 是给人看的 token 用量条
- **状态栏 vs 环境现势**: 状态栏给模型（`last_tool` + open todos）；环境现势给人（cwd/git/diff），不进状态栏 user 消息（#655）
- **沙箱纪律 vs 前景/后景 spawn**: 沙箱纪律约束 `bash` 前台/后台围栏；前景/后景 spawn 是 `spawn_subagent` 的等待契约（ADR-0014）
- **graph mode vs PermissionMode**: graph mode 是编排 overlay；PermissionMode 是 mutating 问/拒/放行。进 Graph 冻结当时 permission，不把 Graph 写入 `PERMISSION_MODES`
- **run_graph vs spawn_subagent**: 有依赖的多节点走 `run_graph`；单次派活仍 `spawn_subagent`。图节点内部仍是前景 spawn，不经父代理再调 spawn 工具
- **父可见信封 vs 磁盘产物**: 父读摘要和路径；写文件以工作区为准，不靠把全文塞进 tool_result
- **子代理并发上限 vs 派发张数**: 上限是帽子；张数由模型按任务拆，说明书写独立才并行
- **说明书静态层 vs memory_layer 整段开关**: 通用 worker 要说明书、不要记忆工具；禁止再靠 memoryEnabled=false 把 AGENTS.md 一起跳过
- **状态栏 vs 任务摘录**: 摘录只在 compact 时贴用户原话；状态栏每轮由代码现算并追加
- **状态栏 vs append-only messages**: 栏走同一条追加纪律；纠错靠新栏，不靠从历史上抠掉旧栏
- **`memory_save`（显式写） vs auto_extract（自动写）**: 两条写路径共用同一套肯定句门禁与 tmp+rename 原子写；显式写是模型当场决定的一次工具调用，自动写是 host 在 turn 完成后异步跑的一趟 ingest。差别只在触发方式与 `source: auto` 标记，不在信任通道——两者都只经 tool_result / prefetch 回到模型
- **memory_catalog vs memory_prefetch**: 目录进 system（抽取开、库非空、短、稳）；预取进用户消息（每轮重算、最多 5 条正文、零词命中不贴）
- **memory_catalog vs promote**: 目录不是指令；promote 才是跨 session 核实后的 system 正文
- **memory_prefetch vs memory_recall**: 同一 `scoreMemoryEntries`；预取宿主先贴最多 5 条；recall 模型主动搜、默认最多 10 条原文
- **dream vs auto_extract**: 字段仍是两个 boolean、默认皆 OFF。产品上 `autoExtract === true` 蕴含梦境（闸仍 24h ∧ 5）；仅 `dream === true` 且关抽取仍允许。钩子在 `autoExtract || dream` 时装配。都关则缺席。同一轮仍先抽取再梦境再 GC。
- **dream vs memory_gc**: GC 仍是零 LLM 的机械软禁；dream 是第二条 LLM 写路径，禁止进入 `gc.ts`。dream 落盘仍可被随后的 GC 按 TTL/cap/supersede 软禁
- **memory_gc vs promote**: GC 是机械减法（TTL / supersede / 超 cap → 软禁）；promote 是机械加法（≥2 个不同 session recall → 进 `system` 段）。GC 不看 promote 状态，promote 不复活 `disabled` 条目；自动条目两边都不享受豁免
- **memory_gc vs memory_recall**: 软禁只改 `disabled`；`memory_recall` 必须在打分前丢掉 disabled 条，否则模型仍看到废条（`specs/memory-layer-follow-ups.md`）
- **stderr 指针 vs 父可见信封**: 信封 summary 只留尾部预览进模型视野；全量诊断在 stderr .log，经指针引用，不进模型
- **blob 引用模式 vs append-only messages**: blob 是 trace 存储层去重；messages 权威历史不受影响，TraceService 仍记录「模型实际所见」
- **tool_result projection vs tool_call.result**: 投影只读 messages；不把 stdout 抄到 `tool_call` 行
- **crash 取证无条件 vs ADR-0003 D10**: 生命周期三类事件 ≠ content trace；D10 的 chat REPL 排除只对 content trace 继续成立
- **worktree isolation mode vs workspaceRoot vs workspace（serve 主根）**: git worktree 是会话级 mutate 物理隔离；`workspaceRoot` 是 per-root 状态锚（ADR-0019）；serve 主根是显式选定锚（ADR-0023）。rebind 只切本会话生效根，不改锚规则本身
- **创建工作树 ACI 工具 vs worktree isolation mode**: 门禁只拦不建；建树与改绑都由模型经该工具完成，内部走 Hub-visible provision seam；Host 不同波重放被拦的写
- **enter/exit 对称工具 vs 持久锚**: enter 的授权与 exit 的目标判定都读持久锚（`session.workspaceRoot` 的树形状记录），不依赖进程内 bound 状态；exit 保留树，enter 只改绑本会话
- **说明书静态层 vs 说明书读法**: 静态层说「哪些文件算说明书」；读法说「缺了怎么办、谁在什么时机拿到正文」——缺目录视为空、不 fatal，父会话按需读不整段灌，general-purpose 子代理开场注入已有文件，explore 不注入
- **user.md vs user-level AGENTS.md vs 项目 AGENTS.md**: 画像与用户级行为约定同根 `~/.iknow/`、对所有项目生效；项目仓库根 `AGENTS.md` 叠在用户级之上且项目优先；都不是记忆库事实文件

## Flagged ambiguities

- **runtime vs optional local mirrors**: product runtime is standalone `iknow`; gitignored trees are never imported
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
- **goal vs 任务摘录 vs 判官 task**: goal 只开 goal 功能；任务摘录只 HITL compact 现抽现贴；完成向 `task` 仅 `goal.text`（ADR-0024 / ADR-0026 / ADR-0032）

---

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

```bash
bash scripts/bootstrap.sh --interactive
```

---

**Maintenance cadence**: monthly review per project memory rules.
