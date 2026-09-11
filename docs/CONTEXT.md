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

**会话文件夹（session folder）**: harness 拥有的按会话记录面——`~/.iknow/projects/<项目 slug>/<conversationId>/`，分组键 = **projectIdentityRoot**（跨 session worktree rebind 不变），叶子 = conversationId 原文；装 session transcript / todos / trace / **内容寻址正文池** / subagents。与「写根 = 模型工作面」对立：这里的东西不是模型交付物，harness 也不把它读进 prompt。ADR-0071。
_Avoid_: 把模型交付物放进来；当第五个根角色（稳定根清单不活化）；用 session `title` / `goal` / worktree label 当文件夹名；把带锁活状态（后台任务登记表 / worktrees 锚点）搬进来

**模型实际所见（what the model saw）**: trace `llm_call.messages` 的语义——那一次调用真正送进模型的累计消息集，含 `<agent_status>` 尾部注入、worker prior messages、compaction 后的摘要视图与 mask 形态。与 **session transcript** **故意不相等**（实测同一会话 `agent_status` 在 trace 14 次 / transcript 11 次），故 trace 不得引用 transcript 来重建它：从增量事件流重算累计数组是**重算不是查表**，会漂移。「所见即所填」不变量的 SSOT 是 ADR-0036（它据此否决 delta/off 写侧模式），不是 ADR-0014。ADR-0036 / ADR-0071。
_Avoid_: 用 transcript 当 trace 正文源；把两者当同一份记录的两种投影；为省空间截断它；把这个不变量溯源到 ADR-0014（那是 subagent spawn 语义，ADR-0036 误引）

**内容寻址正文池（blobs）**: 会话文件夹内的 `blobs/<sha256>`——正文 mask 后另存**一份**、定长 sha256 当文件名、`flag:"wx"` write-if-missing，读侧按 sha 取回原文。哈希在这里是**命名用法不是摘要用法**：原文一字不少地存着，没有压缩也没有丢失；寿命 = 会话文件夹，删文件夹即回收（承接 ADR-0036 悬置未细化的 rotation orphans 规则）。ADR-0036 / ADR-0071。
_Avoid_: 当全局共享池（那要自造引用计数 / GC）；当压缩或摘要；让 trace 引用 transcript 正文来代替它

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

**context usage (display)**: 上下文用量显示 = TUI `ContextBar`（`src/tui/context-bar.tsx`）+ Web `UsageChip`（`web/src/components/UsageChip.tsx`，挂在 Composer）共同消费 `RunResult.lastUsage`（ADR-0008 D5）；wire 字段 = `TurnAnswerDto.lastUsage?` + `HealthResponse.contextWindow`（`src/session-api/` 投影，web 镜像于 `web/src/api/types.ts`）。百分比分子 = `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`（Anthropic 三类 token 互不相交）；分母 = `contextWindow`（来源 `env.compress.contextWindow`，env var `IKNOW_MODEL_CONTEXT_WINDOW`，默认 200000）；Running 时显示上一次已完成的 lastUsage（one-beat lag）。
_Avoid_: ContextUsageStrip；用 chars/N 估算顶替 lastUsage 真值；为显示引入第二份 token 账本；让 contextWindow 走 `deps.compress`（避免触发 auto-compaction 行为变化）

**viewport mount**: ChatView 只把 scrollbox 当前视口加 overscan 内的 transcript 条目挂进 OpenTUI 树；滚动文档仍覆盖全量 `session.messages` 与方案 B banner，高度来自布局实测。
_Avoid_: 固定条数尾窗；行账 / 行窗口；把 LLM `/compact` 当 UI 树裁剪

**fence display cap**: TUI markdown 围栏在 OpenTUI 树上只挂前 32 行，溢出用 `+N more lines`；会话正文仍是全文。与新建文件 10 行预览、编辑 diff 分开。
_Avoid_: 用只挂最近 N 条消息代替围栏截行；把围栏窗改成写预览帽；为省树而删 session 里的代码

**result preview（结果预览）**: 工具标题下的截断输出窗：先做 **progress tick** 再取 bash 尾部最多 5 行（ANSI 透传）；live 完成态与成功落定的 bash 都画。装饰不用每行 `>`，溢出 `… +N 行` 无箭头；失败走 **failure overlay**；`meta` 旁路不进模型。
_Avoid_: 每行 `>`；失败或 retract 仍画预览尾巴；把 meta 经 encodeToolResults 带进 model tool_result；与围栏或写预览帽混用；百分比流按行追加进气泡

**progress tick（进度覆盖）**: `Updating files: N%` / `1%`→`100%` 同一过程只占一行，留当前或最后一跳给人看；`\r` 原地覆盖与连续百分比行都折成这一行。落定不留中间轨迹，也不把这类信息整段藏掉。
_Avoid_: 每一跳百分比占会话一行；把 Updating files 整段藏掉；把进度史当 bash 标题

**write create preview（新建预览）**: 新建文件落定后挂正文前 10 行 + `+N more lines`。不是编辑。
_Avoid_: 6 行帽；把新建预览套到 edit diff 上

**edit diff preview（改动 diff）**: 编辑/覆盖已有文件时，人必须看见**本次改动**的 diff，不套新建那 10 行帽。
_Avoid_: 编辑只露文件头 6/10 行；把改动当噪音收进计数；用整文件当绿块冒充 diff

**settled appearance（落定态）**: TUI 里工具从 live 转为 idle 之后的可见性策略——按类留下足迹、收回去、或点名着色。不是「有已完成工具就整轮折成计数行」。
_Avoid_: 一律折叠；把 live 过程叫落定态；D3 整轮藏标题；过程行加 `[运行中]` / `[完成]`

**live tool line（过程标题）**: 进行中给人看的英文行——思考是 `Thinking…`；命令是 `Running N shell command(s)…` 加可见的 `bash` 命令。工具名加本轮要点（search=query、fetch=url、read=path、grep=pattern）。不要 `[运行中]` / `[完成]`；**retract class** 跑完进折叠计数，不是整段抹掉。
_Avoid_: `[运行中]` 前缀；思考中藏秒数合同另开；跑着的命令只留工具名不露命令；收类未完成就进计数；读/搜整段隐身

**keep class（留）**: 落定后仍画出标题行的工具类（bash / write / edit / 会话动作）。bash 成功留命令 + 折叠后的 **result preview**；新建走 **write create preview**；编辑走 **edit diff preview**；挤档可只留 `Wrote N lines to path`。
_Avoid_: 成功 bash 只留标题把 Updating files 藏掉；只留 dim 预览尾巴；把标题藏进折叠计数；把本次改动折没

**retract class（收）**: 落定后标题和预览都从屏幕拿掉、只进折叠计数的工具类（读取 / 搜索 / 查询，含 `read_file` / `grep` / `web_search` / `web_fetch`）。未知未注册工具缺省也是收。
_Avoid_: 藏标题留预览；给 `read_file` 加内容预览；把失败的收类折进计数；收成「完全不出现」（无过程行、无 `name × N`）

**accent class（点名着色）**: 落定后以非 dim 的 `accent` 色 + 人读表述留在屏幕上的特定能力（skill、task worktree 生命周期工具）。必须进显示注册表。
_Avoid_: 浅色隐藏；只进计数；用 error 红当点名色

**failure overlay（失败横切）**: 任意落定类在失败时覆盖成功态分类——留标题、一行短错误、error 色、不进折叠计数、不用 dim `⎿` 堆长文。error 色优先于 accent。
_Avoid_: 失败跟成功走同一收；把失败当成第四类工具表；失败五行走 dim 预览

**thinking duration（思考时长）**: assistant 消息的落盘属性——adapter 流式路径测量（首条 `thinking_delta` 至首个非思考增量），`thinkingMs` 经 commit 钩子随事件链落盘，`SessionFileV1` 上照 `messageCreatedAt` 模式重建并行数组（additive，schema 版本不升）；折叠簇时长 = 簇内消息求和。非 UI 测量值。
_Avoid_: TUI 墙上时钟副产物（只活当前轮/重启即失/跨会话串味）；挂在 thinking 内容块上（污染 provider replay）；旧会话回填；`thinkingMs <= 0` 或非有限数落盘（字段缺席）

**unit fold**: 结束态**一行**——原先第一行的思考时长（英文 `Thought for <duration>`）接上原先第二行的 `formatToolUseCounts`（`bash × N · read_file × 1` 这类，含收类）。不是两套计数、也不是另造 `ran` 语义。Skill 走 accent，不进这行。无秒数且无计数则不画、不回落 `[思考]`。
_Avoid_: 结束态两行（秒数一行、计数一行）；`思考了 N 秒`；把第二行计数丢掉只留时长；把 skill 折进这行；流式思考钉在 transcript 顶层摊全文

**skill-load display projection**: 给人看的 skill-load 是 `loading skill <name>` 芯片，外加用户 remainder（若有）；SKILL 正文只留在进模型的 skill-load 信封里，不画成 user 气泡。
_Avoid_: 把 `[skill-load name=]` 正文当作用户键入；加载技能；turn 结束后用落盘信封替换显示占位

**chrome focus**: TUI 底栏焦点环 `input` | 子代理行 | `graph` 的单一 reducer；有子代理行时 Down 先入该列，再 graph；Up 反向回到输入框。
_Avoid_: 只有 graph 抢 Down；焦点落在 ContextBar；子代理面板不可聚焦；位置行进焦点环

**session location chrome（会话位置行）**: TUI 底栏在 ContextBar 之下**常驻一行** `路径 · 分支`；绑 task worktree 只换同一行的路径。子代理与 Graph 在它下面（两者都有时子代理在上）；不进焦点环、不进模型消息、不带 dirty/diff。
_Avoid_: 绑树才出现；未绑树 0 行；用显隐当「在不在树上」；常驻第二行 dirty/diff；子代理画在位置行上面

**streaming block freeze**: 会变长的那串 markdown 里，除最后一个顶层块外钉住，后续增量不再 lexer、不再重建前缀子树；边界只前进。
_Avoid_: 把历史消息 memo 当成同一件事；每个新字整篇重解析；冻结时放开围栏 32 行窗

**ToolExecutionContext**: Executor 透传给 handler 的执行上下文 `{ signal }`；run 第三参 signal 原样透传、不创建子 signal，超时由 Executor `Promise.race` 外包而非 ctx 携带。
_Avoid_: 在 ctx 里放 timeoutMs；为每个 handler 建子 AbortController

**in-flight closeout**: abort/timeout/进程死亡时的收尾——live：模型在途则整回合不进历史；工具在途则 assistant 已追加，在途 tool 填 `execution_failed`（`"cancelled"` / `"timeout"`），再编码为 tool_result。signal 优先于 timeout。resume/load：未配对 `tool_use` 填 `"process"`（`InterruptReason` 预留档），**不加** `Interrupted by user.`；mutating 工具须指示先检查副作用再重跑。一律走现有 `encodeToolResults`。
_Avoid_: 回滚已追加的 assistant 回合；悬空未回填的 tool call；把进程死亡当成 cancelled

**required runtime layer / conditional remediation layer**: 017 的两层对仗边界——required runtime layer（signal / timeout / trace / cancelled-timeout 停止 / in-flight closeout）已实施；conditional remediation layer（自动重试、checkpoint 落盘、token-cost 护栏、trace B 层字段、工具分类超时、错误分类细化、总耗时独立 stop、OTel 导出）017 显式禁止，推迟到 018 真实接通后按 013 条件式修复原则补。
_Avoid_: 把 conditional remediation layer 提前带入 Foundation 内核；用禁词扫描注释/JSDoc 代替可执行面能力边界（checkpoint 落盘在 session-api）

**executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段，executor 永不信任工具声称的截断字段（防 MCP 第三方伪造绕过封顶）。#140 裁决，ADR-0004 / ADR-0006。**scope 例外**：`skill()` 正文不在此闸内——它是装配产物（非可再生查询），豁免为内建装配期静态声明；MCP 工具结构性不可取得（ADR-0083）。
_Avoid_: 工具自填 truncated/total 字段；executor 凭工具标记跳过兜底截断；把 skill 正文豁免读成「工具可自证免截断」

**plain-string tool output**: (契约 Y1, deprecated→#298) 原生产工具输出为纯字符串（wire 边界同形态）；bash 例外保留 `{code, stdout, stderr}`（Y1b）。#298 起 Y1「纯字符串」读法被 observability side-channel 取代——model-facing tool_result 仍纯字符串（Y1 精神保留），但 handler 可返 envelope `{ output, meta? }`，`meta` 走观测旁路，永不进模型视野。#140 裁决，ADR-0004。
_Avoid_: 工具自填 structured metadata 进 model tool_result；把 bash 例外推广到其他工具

**observability side-channel**: (#298) 工具观测旁路——handler 返 envelope `{ output, meta? }`；executor 拆分后仅 `output` 字符串化进 model-facing tool_result，`meta`（典型如 edit_file/write_file 的 `oldContent`/`newContent`）经 `PostToolUseHook.payload` → `TuiToolEvent.payload` → `LiveToolRun` 字段供 TUI diff 预览等观测消费者，永不进模型视野。ADR-0004（supersede Y1）。
_Avoid_: 把 meta 拼入 model tool_result；让 TUI / Web 直接读 handler 原始返回对象

**ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；当前 8 件：`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移（#141 / #191 / a277f68）。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。
_Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组（#228 决议 D4——`memory_recall` / `memory_save` 入 SSOT 8+2=10）；让工具返回结构化 metadata

**ACI network surface**: 装配层网络三职——发现是 `web_search`，阅读是 `web_fetch`，通话不升第 9 件工具、只走 `bash` 的 `network: true`（ADR-0022）。形状冻结；发现与阅读的后端选择见 **ACI web backend**。
_Avoid_: curl 工具; http_request; HTTP 原语; 把 method / headers 并进 web_fetch

**ACI web backend**: 发现与阅读共用一个后端名；该后端缺搜索或缺抓取时，缺的那一头回落到内建默认（搜索走现行默认检索，阅读走本机 `web_fetch` + `network-guard`）。
_Avoid_: 分设 search_backend 与 fetch_backend; 把缺的能力当成已接通; 缺抓取时改走 bash curl

**host-net amplify**: `bash` 带 `network: true` 且 ask 被同意后，该次调用宿主网零过滤；不是按域名的小开，也不另注册 curl 工具（ADR-0022；出口过滤见 ADR-0072）。
_Avoid_: 批完再滤; 沙箱代理当默认; 一等 curl 工具

**声明工具面 vs 实际工具面**: `SubAgentDefinition.disallowedTools` 写进 `WorkerEnvelope` 的是声明面；worker 进程装配后真正可被模型调用的工具集是实际面，二者必须相等——裁剪发生在 `createAciRegistry(tools)` **之前**的 def-list 期（`createDefaultAciRegistry` 工厂内），由构造期快照保证，不事后修补（`AciRegistry.inner` 是冻结快照）。
_Avoid_: 给 `AciRegistry` 加 `.tools` 字段在产物上事后裁剪；声明 deny-list 但 worker 不消费（#468 修复对象）

**deps.system injection seam**: Each-turn 系统文本装配的唯一权威缝——loop-engine 调 `deps.system?.()`（`loop-engine.ts:358`），结果透传 `adapter.step request.system`；`undefined` 时不发送 `system` 字段（`anthropic-adapter.ts:577-580` 条件 spread），KV cache 前缀字节级稳定。装配主体是 `identity/assemble.ts` 的 `IKNOW_ASSEMBLY_ORDER` 流水线（#196）。
_Avoid_: 在 adapter 或 host 层直接拼系统；发送空串 `system`（KV cache jitter）；绕开 `deps.system` 在 adapter 内部二次组装

**memory_layer slot**: #196 9 段流水线 slots 5-9（user AGENTS / `PRIORITY_DECLARATION` / project AGENTS / `EXISTENCE_POINTER` / 可选 **memory_catalog**）收敛后的单 slot 名，位置仍在 bootstrap 之后；委托 #121 `createSystemResolver`（`memory/refresh.ts`：mtime 缓存 + inflight 去重 + 装配失败不毒化缓存），内部拼接顺序由 ADR-0009 锁定，目录段由 ADR-0034 追加，promote 段由 ADR-0044 撤出 system。#228 决议 D2。
_Avoid_: 逐 slot 独立消费缓存；再拆拼接后的整串；把拼接顺序拆出 slot 边界独立决策

**surface split (identity vs memory)**: 入口面（`chat` / `tui` / `ask` / `serve`）的两层语义——身份认知层（`identity` / `soul` / `user_profile` + 仅 chat/tui 触发的 `bootstrap`）恒在；记忆层（`AGENTS.md` + rules + 记忆库 + `memory_recall` / `memory_save` 工具）只对 chat / tui / serve 装配，`ask` 全 opt-out（`memory_layer` slot 不挂、memory 工具不入注册表）。#228 决议 D3。
_Avoid_: `ask` 全 opt-out（破"我是谁"答复路径）；`ask` 全 opt-in（破 #121 "ask 无状态"前提）；按 surface flag 同时决定两层

**auto_extract**（`settings.memory.autoExtract`）: 自动记忆抽取的产品总闸，boolean-only、**默认 OFF**——段缺失或非 `true` 一律关抽取与 **memory_catalog** 装配。`true` 时 host 仍按 N≥2 抽，且梦境双闸满足时必跑梦境 LLM（即使 `settings.memory.dream === false`）。仅当 extract 与 dream 均关时 `BuiltEngine.autoMemory` 缺席。ADR-0031 D1/D5；分层 `specs/auto-memory-layering.md`；钩子见 ADR-0033。记忆 body 不进 `system`（ADR-0044）。
_Avoid_: 把默认改成 ON；开抽取却不要梦境；把记忆正文装进 system；把抽取 prompt 内嵌进 loop-engine；给 `ask` 接线；让 ingest 失败冒泡成用户 turn 失败；开抽取却不注 memory_catalog

**memory_op**（`ADD` | `UPDATE` | `SUPERSEDE` | `NOOP`）: persist 仍认四态；**抽取** `decide ops` 只用 ADD / 保守 UPDATE / NOOP（无 CONTRADICTION_FLOOR SUPERSEDE）。`SUPERSEDE` 由梦境 `replaces` 点名后 persist 写出 `supersedes`，旧条仍经 **memory_gc** 软禁。三段函数分离不变。ADR-0031 D2 修订；`specs/auto-memory-layering.md`。
_Avoid_: 抽取再用低词重叠当矛盾作废；把四态压成 upsert；绕开 `memory_save` 写纪律；把三段合成一个函数

**memory_gc**: 可重复、幂等的机械清理，三条规则、**零 LLM**——`ttl_days > 0` 且已过期 → `disabled: true`；被别的条目 `supersedes` 指名 → `disabled: true`；活跃条目超 store cap → 按效用分 `importance × recency × (1 + recall_count)`（recall 次数取自既有 `usage.json` sidecar）从低到高软禁。GC **只软禁不删文件**，误驱逐改一行 frontmatter 就能收回。ADR-0031 D4。
_Avoid_: 硬删文件；把 LLM 离线合并 / 摘要塞进 GC（合并走 **dream**，ADR-0033）；让 GC 依赖 frontmatter + usage sidecar 之外的运行时状态

**promote**: `usage.json` 里一条记忆被 ≥2 个不同 session 召回后的资格。资格只进入 **memory_gc** 效用，**不再**把正文装进 `system`；常驻说明书只在 `AGENTS.md`。ADR-0044。
_Avoid_: 用召回次数买 system 席位；auto-promote；把晋升当记忆进说明书的通道

**memory_type**: 事实条目 frontmatter `type` 的封闭枚举：`convention` | `decision` | `gotcha` | `constraint` | `note`。手动 `memory_save` 与自动 ingest 同一套；空或非法值收成 `note`，不 fail 写入。`specs/memory-layer-follow-ups.md`。
_Avoid_: 自由字符串当 type；自动与手动两套词表；非法 type 整次写入失败

**source: auto**: 自动写入条目的 provenance 标记，落在 frontmatter（`sanitizeMemoryFile` / `serializeMemoryEntry` 已 round-trip 未知字段，无需 schema 升版）。自动条目**只经 `memory_recall` 的 tool_result 与 memory_prefetch 用户侧块**到达模型（低信、常过时），**body 永不进 `system`**（ADR-0044）。没有 auto-promote。该标记同时是批量回退的抓手。ADR-0031 D3。
_Avoid_: 给高 importance 的自动条目开 auto-promote；把 `source: auto` 当成信任等级之外的纯装饰；用别的字段区分人写 / 机写；把自动条包装成必须遵守的规则

**memory_catalog**: 现行条短目录（title + 一句钩子），在 `autoExtract === true` 且库非空时进入 `system`（EXISTENCE_POINTER 之后），带固定英文纪律句（索引不是待办；标题撞词不构成必须召回）。不是条目 body；promote 段已撤出 system（ADR-0044）。上限 200 行 / 25KB。ADR-0034。
_Avoid_: 把目录当全文记忆；抽取关闭时仍灌目录；用中文写纪律句；把目录当必须 recall 的清单

**memory_prefetch**: 每轮按本轮用户原文、用 `scoreMemoryEntries` 选出最多 5 条现行条正文，叠在用户消息侧；零词命中不得入选；包装句英文、标明 advisory；禁止写入 system。不得因 promote 资格排除（system 已无对应段）。会话级按 id 去重：一条记忆一个 conversation 只注入一次，首轮块随 user turn 留在历史（append-only，不 strip，保 KV cache 前缀），resume 扫历史 `id:` 行恢复去重集合，失败容忍一次重复、不 fail turn。ADR-0034 / ADR-0044；去重契约 `plans/auto-memory-prefetch-dedup.md`。
_Avoid_: 把预取写进 system；按 promote 资格从预取里丢掉条目；每轮硬塞满 5 条无关条；预取另起一套打分；会话内每轮重复注入同一条；strip / 改写历史里的旧 overlay（破 KV cache 前缀）；给 `ask` 接线

**dream**（`settings.memory.dream`）: LLM 离线合并开关，boolean-only、**默认 OFF**。闸仍 24h ∧ 5 session。`autoExtract === true` 时闸到后仍跑梦境（不必 `dream === true`）；输出可带 `replaces`，persist SUPERSEDE，不经 CONTRADICTION_FLOOR。闸文件 **dream.json**。其余（skip 推进时间闸、`source: dream`、不进 `gc.ts`）仍见 ADR-0033。
_Avoid_: 把合并塞进 GC；每 turn 强制 dream；与抽取共用 N≥2；默认 ON；dream 条 auto-promote；用 CONTRADICTION 代替 `replaces`；闸文件名含 cursor

**source: dream**: dream 合并写入条目的 provenance 标记，落在 frontmatter（未知字段 round-trip，无需 schema 升版）。与 **source: auto** 同通道：只经 `memory_recall` 的 tool_result 与 prefetch，**body 永不进 `system`**（ADR-0044）。批量回退按 `source: dream` 抓。ADR-0033。
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

**状态栏**: 每次即将调模型前由 harness 算出的现势，以 **user** 消息追加在 `messages` 末尾（含同一用户回合内 tool loop）；旧栏留在历史上，不替换、不写 `deps.system`；UI 只读同一份，in-flight 只给 TUI。字段仅 `last_tool`（本回合尚未跑过工具则为 idle）以及有未勾项时才出现的 todo 段（只投影现行 todo 账本的 `- [ ]` 行；文件缺席 / 空 / 全勾则整段缺席）。ADR-0028；todo 账本见 ADR-0046。
_Avoid_: 每轮替换/删除旧栏；写进 system；把 TUI 当主物；与 context usage (display) 混名；让 LLM 维护栏；把栏接入 verify；每跳塞任务摘录/cwd/技能清单；把调模型时的 in-flight 写进栏；taskFocus / 当前任务卡；空清单仍印 todo 段；全勾后栏里带 `- [x]`；用「本跳是否调用过 todo_write」当在场条件；政策散文进栏；把 **环境现势**（cwd/git/diff）塞进本栏；replace 当跳把新列表再灌进 messages

**todo 账本**: 主会话可修订的任务清单（`todo_write`）；允许开跑前写一版全局步骤，执行中用 replace 换成新的现行列表。现行文件是会话目录里的 `todos.md`；replace 时旧文件改名留在同目录当快照，不当待办。不是图、不是 Plan Mode、不是 Dynamic Pipeline。ADR-0046。
_Avoid_: 把清单并进 `run_graph`；进 plan 相位写计划再执行；同一文件里两套未勾项并存；换表当跳把全文追加进 messages；删掉旧账本文件

**环境现势**: 给人看的工作区快照（至少 cwd / git 摘要 / diff 要点），投放在 TUI（或等价）人读面；**不**写入 ADR-0028 状态栏 user 消息，也**不**充当 verify 输入。#655（G1）验收画像锁定。
_Avoid_: 状态栏；agent-status；把 cwd/git/diff 每跳追加进 `messages`；与 context usage (display) 混名

**沙箱纪律**: 同一 `bash` 调用输入下，前台执行与 `background:true` spawn 共用同一套 bwrap 围栏参数（FS / 网络 / env 隔离 / rlimit / cwdReadonly）；产品路径不得提供无围栏的后台裸跑。#653 G3。
_Avoid_: 把后台当成逃出 bwrap；与 #440 bash 产品面混名；与 spawn_subagent 前景/后景混名

**闭世界围栏（closed-world fence）**: bash 围栏的默认姿态——deny-by-default:home 下非白名单不可见，可写集 = taskRoot + /tmp，其余按 ADR-0037 §9.2 读白名单按需 ro-bind；白名单 miss 分配置故障（spawn 前 typed fail-loud）与工具链断链（运行时可观察）两型。OFF 档同样生效（全档位反转）。
_Avoid_: writable home 打底 + 黑名单补罩（已反转的旧形态）；identity 只读 overlay（§9 已 superseded，身份根改为读白名单恒进成员）

**围栏 /tmp 垫底**: 每个身份（主会话或一个 worker）在会话文件夹里的宿主目录，bind 成该身份围栏的 `/tmp`；寿命跟会话文件夹；不是交付落点。ADR-0074。
_Avoid_: 系统 /tmp；一次 bash 一块空 tmpfs；把垫底当仓库；给「按 id 读」另起产品名

**hard-wall**: spawn 前意图过滤器——拦围栏看不见或拦不住的命令意图（毁灭性 rm、命令替换、敏感路径、fork-bomb），不可被 session grant 覆盖。不是第二套沙箱；换行只作分段符。耐久写只问 `taskRoot`。ADR-0068。
_Avoid_: 把硬墙当沙箱；用换行/`format` 子串当危险；引导把交付物写到 bash `/tmp` tmpfs

**compact reason**: 压缩路径分类，闭集 `below_token_threshold` | `messages_too_few` | `windowed` | `full_summary`，写入 `CompactSessionResponse.reason` 并驱动 UI 文案。`below_token_threshold` 只表示 proactive 未过 auto-compact token gate。
_Avoid_: 把手动 `/compact` 的 noop 写成「未达自动阈值」；UI 字面当业务码；reason 当 `LoopTrace` / `LlmCallRecord` 字段

**auto-compact token gate**: loop-engine 每轮 step 前是否 **proactive** 压缩的阈值，公式 `contextWindow − MAX_OUTPUT_TOKENS_FOR_SUMMARY − AUTOCOMPACT_BUFFER_TOKENS`（`src/harness/compress/threshold.ts`），`IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` 可覆盖。不约束手动 `/compact`。估算只做自动路径判据，不进 trace / `RunResult.lastUsage`（ADR-0008 D6）。
_Avoid_: 把该门当 `/compact` 许可；把字符估算当真实 token；gate 决策绕开 `evaluateCompactTrigger` 直接调 `shouldAutoCompact`

**manual compact**: TUI `/compact` 与 web 压缩按钮触发的一次压缩；执行体与 proactive auto-compact **已开火之后**相同（窗口或 full_summary）。空会话幂等 no-op。
_Avoid_: 等到自动阈值才允许手动压；为手动另写一套压缩器

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
_Avoid_: 进度流；swarm / 子代理互投；把 mailbox 当 D-δ 低层 messaging；接到 run_graph 或图节点（ADR-0076）

**父可见信封**: 子代理交差给父模型看的那一层——短摘要、改过的路径、成败与停因、`task_id` 与该 worker 的 `/tmp` 根；不是终稿全文，也不是垫底里的文件正文。
_Avoid_: 把完整 result 当任务产物；把汇报截断当成任务失败；默认交差附带产物名单

**子代理并发上限**: 同时处于 starting/running 的 worker 硬顶，可配、默认 15；图节点计入同一顶。发几张由模型决定，超限立即失败、不排队。ADR-0014 / ADR-0077。
_Avoid_: 静默排队；让用户每次填写要派几个；per-graph inflight 第二顶（ADR-0077）

**子代理根归属**: 子代理是**父会话的执行臂**，继承父会话当前生效根；不是独立隔离单元。父会话已 rebind 时与父共享同一棵 task worktree；manager 层用父 `conversationId`，worker/LoopEngine 层用自己的 `conversationId`。父会话尚未 rebind 时，满足只读门禁的子代理可留在主仓，但不创建独立 worktree。ADR-0040。
_Avoid_: 每个子代理单独建 worktree；把子代理的 worker `conversationId` 当成父会话路由 ID；把主仓只读放行误读成独立根

**派发门禁判据**: 按**有效工具面能力**推导，**不按角色名匹配**。两维同时成立才允许留在主仓只读运行：(1) 有效工具面不含 `write_file` 也不含 `edit_file`；(2) 有效工具面不含 `bash`，或该角色 `bashMode === "readonly"`。任一维不成立即判为会写；未知角色 fail-closed 判为会写。ADR-0040。
_Avoid_: 用角色名白名单代替能力判定；把父代理 `disallowedTools` 当成 `bashMode` 覆盖；未知角色默认放行

**说明书静态层**: 用户级与项目级 AGENTS.md 及 rules，可注入通用 worker 的 system；与记忆工具、自动抽取、记忆库灌窗分开开关。
_Avoid_: 用 memoryEnabled 一把关掉说明书；把说明书和 memory_recall 绑死

**graph mode**: 会话级编排 overlay，不是 PermissionMode。Shift+Tab 三态轮 `Default → Auto → Graph → Default`（`/graph` 为非 TTY 对等物）；进 Graph 后**下一次 `run()` 装配**才生效（`run_graph` 由 handler gate 解锁、切换提示追加到 messages 末尾），过程中切换不拦、不中途重装配。开着时每个 `run()` **开头**贴一次短 `<graph_mode>` 现势（一轮 = 一次 `run()`，不是内环每一跳）；翻转当拍可另留长 ON/OFF；不进 system、不进 `run_graph` 回执；TUI/CLI 不把该标记画成用户气泡（ADR-0030 / ADR-0041 / ADR-0081）。
_Avoid_: 第四种 PermissionMode；把 `src/harness/graph/` 写进 prompt；env gate 才注入；进图改 ask/auto；切模式当下 round 热替换工具面；每次 run_graph 回执重提编排；每跳 agent_status 灌编排说明书；把开图现势写进 system；每次即将调模型再贴短现势（ADR-0080 已废）；把 `<graph_mode>` 画成 ❯ 气泡

**run_graph**: 常驻注册的 ACI 工具——父代理声明活图（前进边 + 可标明的失败回边），host 走 `validateGraph` → waves → `createSubAgentNodeExecutor`；图节点仍是前景 spawn。graph mode 关闭时由 handler 层 EXIT 拒绝调用，工具面不随模式增删（ADR-0041）。跨回合权威不在单次回执里，见 **活图状态**。阶段 2 绕回仍用这一把，不另开工具（ADR-0061）。一段调用在跑时父代理不能并行干别的；最多主进程静默等待（ADR-0065）。
_Avoid_: 与 spawn_subagent 混名；默认任务进图；模型 import graph 模块；把 condense JSON 当跨回合活图；为绕回另开一把图工具；给 run_graph 或图节点加 wait:false（ADR-0065 / ADR-0076）；把活图叫成 DAG 产品

**活图状态**: 会话持有的那张可修订 DAG 及已完成节点——跨父代理回合、跨多次 `run_graph` 仍是同一张图；已完成在此冻结、不重演。不是 graph mode，也不是单次 `run_graph` 栈帧里的 `GraphExecution`。第一次交节点时建立；关 overlay 不销毁。ADR-0047 / ADR-0051。
_Avoid_: 把 overlay 叫活图；live graph 当 graph mode 别名；图账本（易与 todo 账本混）；把 TUI `graph_progress` 当权威态；关 overlay 当清账本；compact 当丢图

**外环修订**: 改活图剩余结构的刀口——一段 `run_graph` settle 或取消之后，由用户或主代理改 pending（含失败后加重要试格）。阶段 1 的失败再试是加新格，不是图上绕回。ADR-0048。
_Avoid_: 同一次调用波间改图；每个节点唤醒主代理（ADR-0048 / ADR-0076）；把图内环当阶段 1 必达；说「无环就不算图」；阶段 1 单独立「外环次数」硬顶（ADR-0052）；把 Destination 收口做成 host 停闸（ADR-0075）

**剩余子图**: 外环交给 host 的那一截还要跑的 DAG（新节点与仍 pending 的节点）。已完成节点留在活图上、不出现在这次提交里。Host 按 id 冻结终态，禁止再跑。ADR-0050。
_Avoid_: 每次把 done 节点再交一遍当合同；delta 算子（addEdge/removeNode）当阶段 1 主 API

**活图收口**: 活图不再修订的条件——空剩余（模型/用户不再交剩余子图）、人打断或 `/reset`、主 loop 既有停条件。不是 host「管线完成」事件，也不是外环次数硬顶。ADR-0052 / ADR-0075。
_Avoid_: 管线完成；任务完成信号；外环预算闸；phase 3 host 收口

**图内绕回**: 阶段 2：同一次 `run_graph` 里沿边回到未冻结节点，**同一 id 再跑**；失败边也可指向尚未跑过的新格。回边由模型画在图上并**显式标明失败才走**；仅当该格 `NodeOutcome` 为 **failed** 时走，且失败后只启动**一个**格子；done 走前进边；skipped 不走回边。去向交图时写死，host 不选路。校验是图上普通节点，不是 host 暗闸。有圈却未标明回边、或回边指向已冻结 id、或边指向本次没有的 id，则该次调用拒绝。阶段 1 看见失败边标记亦拒。ADR-0053–0067。
_Avoid_: 绕回却换新 id；阶段 1 放开 cycle；done 节点再进圈；host 失败时暗接上游；结束不论成败都走回边；host 另跑测试来决定绕不绕；靠检测环猜哪条是回边；未标明的圈硬跑；回边指到 done 却静默丢边；一格失败同时开多个格子；host 按失败内容改去向；指向不存在的 id 还 invent 节点；阶段 1 丢掉失败标记硬跑

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

**checker 三态 verdict**: 证据充分性判定 = `EVIDENCE_SUFFICIENT` / `EVIDENCE_CONTRADICTED` / `EVIDENCE_INSUFFICIENT`；6 条检查封装在 `evidence-checker.ts` 内部。HITL 用 SUFFICIENT 短路、用 INSUFFICIENT 表示没验过（不请完成向判官、不打绿勾）；CONTRADICTED 在 HITL 不当打回。goal 功能里 CONTRADICTED 仍可硬否决；绿了仍要 LLM 评 `goal.text`。
_Avoid_: 与闭环「三态判定」混同；调用方自数 PASS 条件；`SUFFICIENT` 当作 goal 功能已完成；HITL 见 rm/写空测试就打回

**声称位置**: `checkEvidence` 的窗口右端 = `messages` 数组下标，对准最后一条有非空 text 的 assistant（与 `deriveFinalText` 同一次回扫）；不是 verify 闭环的 `round`。
_Avoid_: 把验证轮次当 claimIndex；首轮只看 messages[0]

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

**hook router**: (ADR-0055) 同进程工厂：把内置钩子（builtin hooks）与用户钩子（user hooks）编成挂上 permission-executor 第 1/5 步的纯 Pre/Post 函数。形态对齐 sandbox 执行面的 in-process router（ADR-0045），不是 OS 进程、不是 HTTP daemon、不并入 sandbox server。
_Avoid_: fork/Unix socket 钩子进程；把 hook router 叫成 `iknow serve`；一个 Policy server 吞 isolation/hard-wall/secrets

**内置钩子（builtin hooks）**: harness 用代码装配的拦截或观测（如 `secrets.mode=block` 的 secrets-guard、TUI `onToolEvent` Post、violation 杀会话观察者）。不出现在 `settings.hooks`，`hooks.enabled` 卸不掉。各自仍走原产品开关（`settings.secrets`、host 是否传 Post 等）。
_Avoid_: 把 auto-memory / isolation / hard-wall 改挂成 settings.hooks 条目；用钩子总闸关掉 `/memory`

**用户钩子（user hooks）**: 操作员声明的 deny-only 规则（V1 = `settings.hooks.rules`；目录文件源是后续贡献，不自动执行）。默认关（`enabled` 缺席=关）。只拦、不改参数/结果、不跑外壳命令。
_Avoid_: 与内置钩子共用一个 enable 字段；目录落盘即生效；同义词 lane / 两车道

**PreWrite (user hook event)**: 用户钩子事件名——同一条引擎内 Pre 缝，仅当 `classifyCall` 判定 mutate 时匹配。不是第 6 步链。
_Avoid_: 第二套「会不会写」分类器；与 worktree isolation 门禁混成一个开关

**PreCommit (user hook event)**: 用户钩子事件名——工具调用形态为 `git commit`（含 `git -C … commit`；第一个非 option 子命令为 `commit`）。不是 session JSONL 落盘（`createChatSessionCommitHook`）。
_Avoid_: 拦 `git status` / `git commit --help`；把 transcript commit 当 PreCommit

**渐进式披露 (progressive disclosure)**: (#631 / ADR-0046) 便宜索引常驻 + 重载荷按需：索引有描述则按精确名加载（`skill({name})` / 直呼 `discover`）；索引没有描述才 `tool_search`。机制仍是 lazy + `discover()` 尾部追加以保 KV 前缀；`<mcp_tools_overview>` 已撤。
_Avoid_: 有描述仍强制先 search；把发现的工具插回注册序中部；概览段发空串占位

**前缀资格线 (prefix eligibility line)**: (D9/ADR-0043) 一段内容要有资格留在模型面前缀区（`tools` + `system`），判据是其输入来源**构造上**不可能在会话内变——「实测没变」不算数，代码上不可能变才算数。会话内可变的闸门只许落位 messages 尾部或 handler 层（ADR-0041）。执法 = 两条断言：`IKNOW_ASSEMBLY_ORDER` 声明↔产物一致性、相邻两轮装配 tools+system deep-equal。
_Avoid_: 以实测抖动频率辩护前缀区易变段；用 chars/4 估算参与溢出判定；中途改写已发出的前缀字节

**名字目录 (tool name catalog)**: (ADR-0043 / ADR-0046) MCP 与退场内建件在 system 的会话冻结索引——默认名+短描述；schema 不 upfront，有描述则直呼 `discover` 双写进 `tools` 尾部。
_Avoid_: MCP schema 全量 upfront；目录随连接改写；有描述仍报错逼 `tool_search`

**直呼加载 (exact-name load)**: (ADR-0046) 前缀已有名字时按该名灌贵载荷——`skill({name})` 取 SKILL.md；未 discover 的工具或 MCP 调其名即 `discover`（参数齐则执行）。
_Avoid_: 有描述仍先 `tool_search`；用已删除的 `skill_search`

**skill() 二次短路**: 模型再调同名 `skill()` 时，若可见 messages 仍有该名成功全文 `tool_result`，只回短回执、不重装 SKILL 正文；compact 丢掉该条后才再灌全文。闸只罩 ACI `skill()`。ADR-0079。
_Avoid_: 会话级已加载 Set；写处境变化当再灌理由；system 记已加载集合；静默吞掉配对 `tool_use`；slash / Web `getSkillBody` 一并短路

**索引降档 (index demotion)**: (ADR-0046) MCP 与 skill 索引合计超窗口 10% 时，超限条目剥描述只留名；退场内建不参与剥描述。
_Avoid_: 从目录删除条目；把 schema 退场内建件也剥成裸名

**开局等待 (startup connection wait)**: (ADR-0043) 首轮模型请求前等待 MCP server 连接完成（超时 30s，超时者停止自动重试、本会话缺席）——首个请求发出前前缀即定稿，窗口内连上零破坏。手动重连成功只往 messages 尾部追加一条通知；会话中断开则调用报错、tools 与历史一字不动。
_Avoid_: 会话中自动重连后改写 tools；超时后继续阻塞启动；把手动重连通知写进 system

**溢出治理 (tool-surface overflow governance)**: (ADR-0043 / ADR-0046) schema 超窗口 10% 时内建退场件进目录为名+描述；MCP/skill 索引超 10% 时只剥这两类描述、不删名。皆 countTokens 实测、仅首轮一次。
_Avoid_: 会话中重算；chars/4 估阈；退场内建剥成仅名字；从目录删名

**会话级快照段 (session-snapshot segment)**: (ADR-0042) 装配时取一次快照、会话内冻结的 system 段（当前住户：`memory_layer` catalog、git 块；promote 段已撤出，ADR-0044）——语义是「快照」而非「缓存」：不再比对源变更，下个会话才重取。新落盘内容对当前会话不可见是已接受代价。
_Avoid_: 与 mtime 门控缓存混同；会话中因源文件落盘而刷新；把快照段写进 messages

**git 块 (git status block)**: (D1/ADR-0037 §4) 模型侧 git 感知的 system 段——当前分支 / 主分支（注明 PR 基线）/ status（截断上限 + 截断标记）/ 最近 5 条 commit，附「开局快照，会话期间不更新」免责句；读稳定 `projectIdentityRoot`（rebind 不抖）；退化态（非 git 仓库 / git 不可用）= 段整体缺席。属会话级快照段。
_Avoid_: 块内放 diff；每回合刷新 status；rebind 时重建该段；缺席时渲染空占位

**git 作业**: 主代理用 `bash` 完成的版本库侧效应链（工作区变更 → add → commit），不单独注册 ACI 工具。纪律段仅在 worktree isolation ON 时挂 chat/tui/serve，不进 ask / worker；远端不进 identity。
_Avoid_: git ACI 工具；`git_commit` / `git_push`；把环境现势当作业面；让只读子代理提交；把 push / network 写进 system

**stderr 指针**: worker crash 取证三件套的落盘形态——`subagent_stop.error` 结构化字段 + `stderr_path`/`stderr_bytes` 指针字段 + `<会话文件夹>/stderr/<taskId>.log` mask 后全量文件；父可见 summary 只留尾部 ≤2000 字符预览。specs/trace-agent-readability.md。
_Avoid_: 把完整 stderr 内联进 JSONL 行；stderr 落盘绕过 SC20 mask；把 summary 截断当成诊断丢失

**blob 引用模式**: 已退役的 opt-in 开关名（曾 `IKNOW_TRACE_MESSAGES=blob`，默认 `full`）。现行唯一形态是 **内容寻址正文池**（content 级 `{role, content:{sha,bytes}}`，正文在会话文件夹 `blobs/<sha256>`）。ADR-0036 / ADR-0071。
_Avoid_: 当作仍可切换的存储模式；写仓库根 `<traceDir>/blobs`；整条 message 替换（role 被吃掉）

**tool_result projection**: 从已解引用的 `llm_call.messages` 抽出的工具结果摘要（`tool_use_id` / name / is_error / chars / preview）。供 `query_trace` 列表与下钻；**不是** `tool_call` 行上的 stdout 副本。`specs/query-trace-tool-results.md`。
_Avoid_: 打开 `resultCaptured` 往 tool_call 抄正文；把投影当会话账本；默认下钻倒 messages 全文

**role projection**: trace 读侧（`src/traceserver/` 共享核，ACI + MCP 两张皮共用）对 `llm_call.messages` 中 message role 的可见性投影——`query_trace` llm_call 行投影的 `last_assistant_preview`（最后一条 role=assistant 消息的预览，无则字段缺席）与 `get_record(detail=messages)` 清单臂每 part 的 `role` 字段；外部 agent 定位最终 assistant 结论不需盲翻 parts。plans/trace-mcp-role-projection.md。
_Avoid_: 改 `last_message_preview` 语义（它仍是逐字最后一条消息的预览）；把它当新增读侧工具（SC6 三件白名单不变）；在 `detail=tool_results` parts 上加 role（tool_result 按定义在 user 侧）；窗臂响应添 role（窗寻址已有 message_index）

**crash 取证无条件**: `subagent_spawn`/`subagent_state_change`/`subagent_stop` 生命周期事件与 stderr 指针文件在所有产品入口（含 chat REPL）落盘，与主循环 content trace 的入口开关解耦。ADR-0035（对 ADR-0003 D10 的范围修正）。
_Avoid_: 把生命周期事件绑回 `--trace-out`；把该扩张理解为 content trace 进 chat REPL

**worktree isolation mode**（`settings.isolation.worktreeOnMutate`，默认 OFF）: 全局隔离开关——OFF 时会话行为与今日完全一致；ON 时会话可只读主仓，写路径 mutate 被门禁拦下（门禁**从不**自动建树），由模型调 `create-worktree` ACI 工具建 task worktree（含 task 分支）并 **session worktree rebind** 到该树，此后本会话 mutate 只进该根；已绑定则放行，不建第二棵树。只在启动加载点读取一次；config 层不读 git、不持会话状态；改绑不隐式重载 project settings。建树/绑定失败与主仓非 git 仓库一律 fail-closed：typed 可见错误，不静默放行写主仓。task worktree / 分支名已存在 → 报错不覆盖。ADR-0037（对 ADR-0023「worktree/多根只读推迟」的窄面 reopen；git worktree ≠ product workspace 多根）。条件 ACI 同族另有 `list-worktrees` / `remove-worktree`；`create-worktree` 可带 **task worktree label**（`specs/task-worktree-lifecycle.md`）。
_Avoid_: 默认 ON；门禁自动建树（auto-provision）；把建树当 host 职责而非模型调工具；把 git worktree 混成 serve 主根或 `workspaceRoot` 多根；config 层读 git 或持会话状态；改绑后隐式重载 settings；建树失败静默写主仓；只建树不改绑会话；同名树静默覆盖

**session worktree rebind**: worktree isolation mode ON 下 `create-worktree`（或 enter / exit）ACI 工具成功后，把**当前会话**生效的根锚（cwd / `workspaceRoot` 取值）切到本会话 task worktree 的动作；只影响本会话——不 checkout 其它会话 / 其它 worktree 的 HEAD，push / 开 PR 不拖动主仓或其它 worktree 当前分支。同会话重复调工具幂等（一棵树、一个 task 分支，不跑第二次 `git worktree add`）。**生效边界：同一轮（run）内对下一波 tool calls 生效**——建树成功的当波 mutate 仍按波快照旧根裁决，下一波起写与工具 cwd 落进新树；不需要操作员再发消息或 `/continue`。发现与回收走同族条件工具 `list-worktrees` / `remove-worktree`（ADR-0037；`specs/task-worktree-lifecycle.md`）。
_Avoid_: 改绑波及其它会话；把 rebind 当 serve 主根重绑（ADR-0023 unbound / recents 语义不变）；让 rebind 触发 settings 重载；把改绑后的根错当成 product workspace 多根；把 rebind 说成 mutate 门禁的自动副作用；要求操作员再发一条消息才生效（same-turn 生效语义已随活 taskRoot 落地）

**task worktree label**: 给人/模型认树的 kebab 目录名。有合法 label 时叶子就是 `<slug>`，conversationId 不进文件夹（写在 gitdir sidecar；历史 `<slug>--<conversationId>` 仍可反演）。非法或缺席则叶子仍是纯 conversationId。同名已存在 → 建树失败不覆盖。
_Avoid_: 把 label 当 conversationId；用 session `title` / `goal` 当 slug；把 uuid 写进文件夹名当展示面

**worktree tool description（工作树工具说明书）**: 注册名是 `create-worktree` / `enter-worktree` / `exit-worktree` / `list-worktrees` / `remove-worktree`。description 先服务 agent：能不能调、做什么。人喊创建是第二层提示词 + 夹具；拦截点名是 harness。ADR-0082。
_Avoid_: `create-task-worktree` / `enter-task-worktree` 等旧注册名当模型面；把 `[worktree_isolation]` 写进 description；把 list 写成 create 前置；把「何时该调」政策写进 schema

**占用（worktree claim）**: 一棵 task worktree 被某会话占用，判据 = **现存会话记录里有别人的 `workspaceRoot` 指着它**；零新持久状态（不写锁文件、不加 sidecar 字段、不建注册表、不加跨调用内存 Map）。释放是 `exit-worktree` 的自动后果（该字段改回主仓根），或删除该会话记录；崩溃未 exit 的僵尸占用靠「恢复该会话让它自己 exit」解开（restart-safe adoption）。owner sidecar **只负责告知，不负责授权**。拦截仅在 `isolation.worktreeExclusive` ON 档生效，默认 OFF 且 OFF 档 enter 行为逐字节不变。ADR-0070。
_Avoid_: 用 sidecar 归属当授权或当锁；活性检测（PID 探活 / 心跳 TTL）；`release` 命令；`force` 覆盖参数；把排他当默认档；把占用与「写处境」告知耦成同一个开关

**worktreeinclude**: 位于 **projectIdentityRoot** 的 `.iknow/worktreeinclude`（gitignore 语法）。`create-worktree` 成功后只把「匹配且已被 gitignore」的文件拷进新树；文件缺席不失败建树。
_Avoid_: 拷 tracked 文件；把 include 当第二份身份根；include 失败阻断 provision

**taskRoot**（活值）: 会话当前生效的 task worktree 根——**写与工具 cwd 只问它**（写工具 / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录）。活性语义（`src/harness/session-roots.ts` 的 `LiveTaskRoot` cell）：**调用时读取**——所有消费点（门禁 shape 判定、写工具 resolve、bash 围栏、LSP directory、子代理 spawn 取根、环境现势）在 handler 调用时机读 cell 快照，不再闭包冻结装配期根；**唯一 writer = 装配层对 host `provision` / `enter` / `exit` 缝的包装点**（`withLiveTaskRootWrite`，缝成功 resolve 才写，失败不写不回滚、typed error 原样冒泡）；**batch 快照（一波一根）**——一次 `executeAll`（= 一波 tool calls）只在入口读一次，整波共用该快照，波内建树不把一次逻辑改动劈进两棵树。装配初值 = `SessionRoots.taskRoot`（未改绑时等于主仓）；`productRoot` / `projectIdentityRoot` / `installRoot` / mcpConfigRoot / stateAnchor 等稳定根**不**随它走。改绑后模型经 worker prior messages / path-outside 回执看见当前写根；消费 skill 时（slash 信封 / `skill()` tool_result / Web `getSkillBody`）只灌技能程序，正文不挂写根 trailer（ADR-0079）；告知面为 worker prior 与改绑后主会话一次，均按「写处境」三态渲染，`no_writable_root` 态只陈述事实、不点名 `create-worktree`（ADR-0069）；改绑后主会话经用户消息缝再给一次（非每轮、不进 system）；system `## Project path` 仍是身份根（`projectIdentityRoot`），bash 围栏把身份根恒进读白名单（closed-world fence）以保证「写仍不得进主仓」（ADR-0037 §9）。
_Avoid_: 闭包冻结装配期根（rebind 只在 run 边界重解析的旧实现）；第二写入口；一波内逐 call 重读（中途翻转劈两树）；把活 taskRoot 当 `productRoot` / 身份根 / per-root 状态锚（D3 稳定根清单不活化）；把「下一波生效」误述为「下一 turn」或要求 `/continue`；告知面无条件宣告「突变写该根」（隔离 ON 且未绑树时与门禁真值相反，见「写处境」）

**写处境（write situation）**: 「此刻能不能写、写哪」的三态纯函数判定——`writable_main`（隔离 OFF，主仓可写）/ `writable_tree`（隔离 ON 且活 `taskRoot` 是树形）/ `no_writable_root`（隔离 ON 且非树形，无处可写）；判据 = 隔离开关 + **复用** `isTaskWorktreePath`，**不是**归属 sidecar（`enter-worktree` 四道检查无归属，会话可合法 adopt 外来树并被门禁放行）。告知面（worker prior / 改绑后注入）**共享此判定但不共享措辞**：`no_writable_root` 只陈述事实、不点名 `create-worktree`，点名留在门禁回执（意图已证）。skill 正文不挂写根 trailer。ADR-0069；告知面组成见 ADR-0079。
_Avoid_: 用 owner sidecar 当可写判据（会对 adopt 外来树的会话造反向谎）；重写第二份形状判断（shadow copy）；告知面与回执共用一份措辞；把 `no_writable_root` 写成祈使句；把 `/tmp` 短命事实塞进写根段（属 bash 面）；把写处境绑回 `skill()` 正文

**productRoot**: 每个产品入口首次装配确定的稳定主 checkout root；session worktree rebind 后保持不变，不随当前 task worktree 改写。
_Avoid_: workspaceRoot；task worktree root；product workspace 多根

**mcpConfigRoot**: 由 productRoot 派生、跨 session worktree rebind 保持稳定的 MCP 配置根；只读取 `<mcpConfigRoot>/.iknow/mcp.json`，不切换到 task worktree。
_Avoid_: workspaceRoot；task worktree；process.cwd()

**SessionRoots**: 会话四角色根 SSOT（`src/harness/session-roots.ts`）——`productRoot` / `projectIdentityRoot` / `taskRoot` / `installRoot` 一次按角色归位，消费者只消费返回值，不再自行拼 `join(cwd, '.iknow', …)`、读 `process.cwd()` 或自行判断 task worktree。`resolveSessionRoots` 是纯函数：不读 git、不碰文件系统、不持会话状态，缺根 / 空白 / 相对 / 不可规范化一律 typed fail-closed（`SessionRootError`），**绝不**回退 `process.cwd()`。
_Avoid_: 「三根」（实为四角色）；把 `resolveSessionRoots` 当有 IO 的解析器；让消费者自行拼 `.iknow` 路径；用 `workspaceRoot` 顶替角色分工

**projectIdentityRoot**: 用户此刻在做的那个项目的身份根，宿主启动时钉一次、跨 session worktree rebind 不变——**项目身份只问它**：rules / 项目 `AGENTS.md` / `permissions.toml` / 项目 skills 发现 / 子代理继承的身份根 / 记忆库命名空间名。与 `productRoot` 分开是因为宿主按 ADR-0019 从 `workspaceRoot` 取 `productRoot`，而 `--workspace-root <dir>` 重定向档下 `dir ≠ cwd`；取值由装配层决定（宿主钉的值优先，缺席时 `mainCheckoutOf(cwd)`），校验在 SessionRoots。
_Avoid_: productRoot；workspaceRoot；cwd；task worktree（身份根不可以是 task worktree，钉与不钉两条路径都过 `mainCheckoutOf`）

**installRoot**: iknow 运行时自身的安装位置（子代理 worker bootstrap 解析 tsx 与自身依赖），锚 `import.meta.url` 向上找最近 `package.json`，**不**锚任何会话根或 `process.cwd()`；进程级缓存、刻意不给 reset 缝（测试换安装根走 `opts.installRoot` 注入）。≠ 用户项目的 `node_modules`，故裸 task worktree 上 worker 仍能起。
_Avoid_: workspaceRoot；taskRoot；用户项目 `node_modules`；`process.cwd()` 相对解析

## Relationships

- **run() messages -> adapter streaming arm -> interpretMessage**: harness LLM path（流事件以 `HarnessStreamEvent` 经 `onStream` 暴露）
- **turn -> LoopEngine -> tool call -> result -> next turn**: harness 驱动；tool use 经 ACI permission middleware
- **Session HTTP -> run() -> AssistantTurnResult -> SessionHub**: session-api host 路径；messages 每回合投影到 UI
- **skill 正文豁免 vs 契约 X**: 豁免是**装配期静态声明**（内建 skill 工具落值，executor 读），不是工具运行期自称；契约 X 禁的是「工具声称截断字段绕过封顶」，两者不冲突（ADR-0083）
- **正常模式 vs 自动模式**: HITL 每轮还键盘 vs 权限 `full_auto` 本轮不问工具；goal 功能不是这一对
- **HITL 判官 vs goal 功能**: 两套判断逻辑模块，共用判官系统；不是一条 `goal ?? query` 链（ADR-0024 机制仍在，产品口不叫自动模式）
- **声称位置 vs verify round**: 窗口右端是 messages 下标（与 `finalText` 同源回扫）；`round` 只记验证第几轮（ADR-0073）
- **continue_pending vs goal 功能**: continue 是 HITL 同一会话 skip-append；`/goal` 钉着则拒绝（`goal_active`），禁止把 continue 当 goal 续跑的下一跳
- **自动模式 vs goal 功能**: 自动模式是权限；goal 功能是斜杠钉使命后的续跑。正交，可同时开
- **continue_pending vs in-flight closeout**: continue 只消费 `store.load` 的 closeout 投影补悬空 `tool_use`；不另写 sanitize 去删改 tool 对，也不把 closeout 本身当续跑口令
- **状态栏 vs context usage (display)**: 状态栏是给模型的现势快照；context usage (display) 是给人看的 token 用量条
- **状态栏 vs 环境现势**: 状态栏给模型（`last_tool` + open todos）；环境现势给人（cwd/git/diff），不进状态栏 user 消息（#655）
- **会话位置行 vs 环境现势**: 位置行是常驻身份（主仓/分支/树）；环境现势可以更宽，本轮位置行不带 dirty/diff
- **todo 账本 vs 状态栏**: 账本是磁盘现行 `todos.md`；栏只投影其未勾行。replace 当跳不另灌列表；后续回合靠栏，不靠把快照拼进 messages（ADR-0046）
- **todo 账本 vs run_graph**: 轻规划/清单在主 loop 的 todo；DAG 与长程管线在图上，不把 todo 当管线
- **活图状态 vs graph mode**: 活图是会话里那张图的权威账本；graph mode 只是能否调用 `run_graph` 的 overlay。关 overlay 不停用账本，直到 `/reset` 或会话结束（ADR-0051）
- **活图状态 vs run_graph**: `run_graph` 是往活图上跑/修订的入口；单次 tool_result 不是跨回合真相
- **活图状态 vs todo 账本**: 清单可 replace、不当管线；活图冻结已完成节点并修订剩余 DAG（ADR-0046 / ADR-0047）
- **外环修订 vs 图内环**: 外环是阶段 1 改 pending（仍是 DAG）；图内环是阶段 2 把绕回画进拓扑。阶段 1 不设外环次数硬顶，effort 缝留给阶段 2（ADR-0048 / ADR-0052）
- **图内绕回 vs 剩余子图**: 绕回是一段调用内同一 id 再跑；剩余子图是调用之间只交还要跑的节点（ADR-0050 / ADR-0053）
- **显式回边 vs 从环推断**: 失败才走的边必须写明；不因图上有圈而猜哪条是回边（ADR-0058）
- **未标圈 vs 合法回边图**: 圈上该走的回边没写明则该次调用拒，不当 DAG 硬跑（ADR-0059）
- **回边 vs 已冻结 id**: 回边不得指向 done；指向则该次调用拒，不丢边硬跑（ADR-0060）
- **一条失败边 vs 扇出**: 一格 failed 只启动一个格子；要串行再做就画成链（ADR-0062）
- **失败去新格 vs 回走旧格**: 两种都由模型在交图时指定；host 不选路（ADR-0063）
- **未知 id vs 合法边**: 边的终点必须出现在这次提交的节点里，否则拒（ADR-0066）
- **阶段 1 vs 失败边标记**: 阶段 1 看见标记就拒，不忽略后当 DAG 跑（ADR-0067）
- **effort 熔断 vs 外环次数**: 阶段 2 按单次调用每 id 进入次数防空转，默认阈 8；阶段 1 不设外环次数硬顶；Destination 第四句仍不另做 host 停闸（ADR-0052 / ADR-0057 / ADR-0064 / ADR-0075）
- **活图收口 vs 任务完成**: 空剩余只说明不再交格；用户目标完成在主代理/人，host 不广播完成（ADR-0075）
- **外环修订 vs run_graph**: `run_graph` 跑当前这一段 DAG；外环是这段结束之后改活图
- **剩余子图 vs 活图状态**: 剩余子图是这一次还要跑的；活图是含已完成在内的全账本（ADR-0050）
- **plan/实施/replan vs 活图状态**: 前者是主代理认知循环；后者是有依赖、要冻结时的落地，不是规划的超集（ADR-0049）
- **沙箱纪律 vs 前景/后景 spawn**: 沙箱纪律约束 `bash` 前台/后台围栏；前景/后景 spawn 是 `spawn_subagent` 的等待契约（ADR-0014）
- **graph mode vs PermissionMode**: graph mode 是编排 overlay；PermissionMode 是 mutating 问/拒/放行。进 Graph 冻结当时 permission，不把 Graph 写入 `PERMISSION_MODES`
- **开图提示 vs run 首短现势**: 翻转当拍可留一条长 ON/OFF；开着期间每个 `run()` 开头贴一次短「仍开着」，同一轮内环不再贴（ADR-0041 / ADR-0081）
- **图现势 vs system 前缀**: 开着/关着会变，不进 system；现势走用户侧每个 `run()` 一句，不靠抖 tools/system，也不单靠 compact 特补或每跳追加（ADR-0081）
- **run_graph vs spawn_subagent**: 有依赖的多节点走 `run_graph`；单次派活仍 `spawn_subagent`。图节点内部仍是前景 spawn，不经父代理再调 spawn 工具
- **run_graph vs 图内绕回**: 绕回仍走同一把 `run_graph`；阶段差在 host 认不认标明的回边，不在工具名（ADR-0061）
- **run_graph vs 后景 spawn**: 图没有 `wait:false`；跑图时父代理不能并行干别的，最多主进程静默等 settle；mailbox 不进活图（ADR-0065 / ADR-0076）
- **父可见信封 vs 磁盘产物**: 父读摘要、`task_id` 与 `/tmp` 根；仓库文件以工作区为准；垫底正文按 id 去读，不靠把全文塞进 tool_result
- **围栏 /tmp 垫底 vs taskRoot**: 垫底是当前身份的 `/tmp`，不是交付；要留下的写 `taskRoot`，不自动从垫底拷进仓库
- **子代理并发上限 vs 派发张数**: 上限是帽子；张数由模型按任务拆，说明书写独立才并行
- **图节点 vs 子代理并发上限**: 活图格子是同一顶上的 worker，不另起每图预算（ADR-0077）
- **说明书静态层 vs memory_layer 整段开关**: 通用 worker 要说明书、不要记忆工具；禁止再靠 memoryEnabled=false 把 AGENTS.md 一起跳过
- **状态栏 vs 任务摘录**: 摘录只在 compact 时贴用户原话；状态栏每轮由代码现算并追加
- **状态栏 vs append-only messages**: 栏走同一条追加纪律；纠错靠新栏，不靠从历史上抠掉旧栏
- **`memory_save`（显式写） vs auto_extract（自动写）**: 两条写路径共用同一套肯定句门禁与 tmp+rename 原子写；显式写是模型当场决定的一次工具调用，自动写是 host 在 turn 完成后异步跑的一趟 ingest。差别只在触发方式与 `source: auto` 标记，不在信任通道——两者都只经 tool_result / prefetch 回到模型
- **memory_catalog vs memory_prefetch**: 目录进 system（抽取开、库非空、短、稳）；预取进用户消息（每轮重算、最多 5 条正文、零词命中不贴）
- **memory_catalog vs promote**: 目录是短索引（通道是否仍进 system 见 ADR-0034 D1）；promote 是 GC 用的跨会话召回资格，不再提供 system 正文（ADR-0044）
- **memory_prefetch vs memory_recall**: 同一 `scoreMemoryEntries`；预取宿主先贴最多 5 条；recall 模型主动搜、默认最多 3 条原文（读通道不下令召回，spec casual-ask-context-hygiene）
- **dream vs auto_extract**: 字段仍是两个 boolean、默认皆 OFF。产品上 `autoExtract === true` 蕴含梦境（闸仍 24h ∧ 5）；仅 `dream === true` 且关抽取仍允许。钩子在 `autoExtract || dream` 时装配。都关则缺席。同一轮仍先抽取再梦境再 GC。
- **dream vs memory_gc**: GC 仍是零 LLM 的机械软禁；dream 是第二条 LLM 写路径，禁止进入 `gc.ts`。dream 落盘仍可被随后的 GC 按 TTL/cap/supersede 软禁
- **memory_gc vs promote**: GC 是机械减法（TTL / supersede / 超 cap → 软禁）；promote 资格只进入效用所用的 `usage.json`，不把条目装进 `system`（ADR-0044）。GC 不复活 `disabled` 条目
- **memory_gc vs memory_recall**: 软禁只改 `disabled`；`memory_recall` 必须在打分前丢掉 disabled 条，否则模型仍看到废条（`specs/memory-layer-follow-ups.md`）
- **stderr 指针 vs 父可见信封**: 信封 summary 只留尾部预览进模型视野；全量诊断在 stderr .log，经指针引用，不进模型
- **blob 引用模式 vs 内容寻址正文池**: 前者是已退役开关名；后者是现行唯一落盘形态。messages 权威历史不受影响，TraceService 仍记录「模型实际所见」
- **tool_result projection vs tool_call.result**: 投影只读 messages；不把 stdout 抄到 `tool_call` 行
- **crash 取证无条件 vs ADR-0003 D10**: 生命周期三类事件 ≠ content trace；D10 的 chat REPL 排除只对 content trace 继续成立
- **git 作业 vs worktree isolation mode**: 作业是 bash 上的版本库侧效应；隔离是写路径落点（现行 model-provision，见本表 **worktree isolation mode**）。隔离开时作业在 task 树内做完
- **git 作业 vs 环境现势**: 现势给人看仓；作业是模型经 bash 改仓。现势不进模型消息
- **git 作业 vs git 块**: 作业是纪律 SOP（`## Git work`）；git 块是会话级分支/status 快照（`## Git`）。两段并存，不得互替
- **worktree isolation mode vs workspaceRoot vs workspace（serve 主根）**: git worktree 是会话级 mutate 物理隔离；`workspaceRoot` 是 per-root 状态锚（ADR-0019）；serve 主根是显式选定锚（ADR-0023）。rebind 只切本会话生效根，不改锚规则本身
- **session worktree rebind vs taskRoot（活值）**: rebind 是动作（缝成功 resolve 的那一刻），taskRoot 是该动作写入的活 cell；动作对下一波 tool calls 生效（波快照边界），cell 读取面始终回答「当前生效根」
- **task worktree label vs conversationId**: label 是文件夹名与 enter 定位；conversationId 是归属身份，不写进目录名
- **工作树说明书 vs 闸 vs 提示词**: description 先回答 agent 能不能调、做什么；写被拦点名是 harness；人喊创建是 usage/夹具
- **create-worktree vs create-task-worktree**: 模型面用前者；后者是旧注册名，不再给模型
- **settled appearance vs result preview**: 落定三类决定谁还上屏；成功 bash 的结果预览是折叠后的尾窗，不是百分比轨迹
- **必须看见 vs 噪音**: 本次改动 diff、新建 10 行预览、进行中命令、位置行、进度最后一跳必须看见；中间百分比轨迹、`[运行中]`、收类正文、`<graph_mode>` 气泡是噪音
- **本轮人读合同 vs 旧显示数字**: 一行 `Thought for …` + 原第二行计数 / 进行中 `Thinking…` 与可见命令 / 新建 10 行 / 编辑 diff / 位置常驻 / 图每个 `run()` 一次 —— 与旧两行折叠、`思考了`、6 行帽、`[运行中]`、仅绑树才显示冲突时以本轮词条为准
- **新建预览 vs 改动 diff**: 新建才 10 行帽；编辑不套该帽，人要核验的是这次改了什么
- **failure overlay vs retract class**: 失败覆盖「收」，失败工具出独立行，不折进计数
- **accent class vs failure overlay**: 成功点名走 accent；失败时 error 色优先，不用品牌色表示出错
- **user.md vs user-level AGENTS.md vs 项目 AGENTS.md**: 画像与用户级行为约定同根 `~/.iknow/`、对所有项目生效；项目仓库根 `AGENTS.md` 叠在用户级之上且项目优先；都不是记忆库事实文件
- **直呼加载 vs tool_search**: 前缀有描述则按名加载；无描述才 search。退场内建保持名+描述故不走 search
- **索引降档 vs 溢出治理（schema 退场）**: schema 退场把内建变成名+描述；索引降档只剥 MCP/skill 描述
- **skill vs tool_search**: skill 按名取正文；工具/MCP 定义走直呼 `discover` 或无描述时的 `tool_search`；无 `skill_search`
- **skill() 二次短路 vs 渐进式披露**: 披露管索引常驻、正文按需进 messages；二次短路管同名 `skill()` 不再灌第二份全文
- **skill() 二次短路 vs skill-load 信封**: 闸只罩模型 `skill()`；用户 slash 再装信封仍灌全文
- **写处境告知面 vs skill 正文**: 告知走 worker prior / 改绑一次；技能程序不附 trailer；写工具成功路径不另注写处境
- **hook router vs sandbox server**: 都是同进程 router；sandbox 管围栏执行，hook router 管声明式拦截组合，不共用一个 server
- **内置钩子（builtin hooks） vs 用户钩子（user hooks）**: 代码装配 vs `settings.hooks`；用户总闸卸不掉 builtin
- **用户钩子（user hooks） vs 产品开关（memory / secrets / graph / isolation）**: 正交；`hooks.enabled` 不代管 `/memory` 或 `settings.secrets`
- **PreWrite vs worktree isolation mode**: PreWrite 是用户 deny 事件；isolation 是写主仓门禁，不是 `settings.hooks` 条目
- **PreCommit vs session transcript 落盘**: PreCommit 拦 git commit 形态；JSONL append 仍是 host commit hook，不是 user 事件

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
