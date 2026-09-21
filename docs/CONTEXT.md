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

**session-title event**: transcript 里与 **message** 并列的标题记录；lite 生成的权威落点，不进 `messages`、不进模型 prior。header `title` 只是列表缓存（有事件用事件正文；无事件才 `extractTitle` 占位）。没有给人改名的入口。ADR-0113。
_Avoid_: 把 compact 摘要当列表标题；有标题事件后还用 `extractTitle` 回盖；把标题事件投影进 prior；会话 `/rename` / 列表点按改名

**lite model**: 用户 settings `settings.llm.liteModel`——与 `llm.model` 同形的 `provider/model` 路由，走同一 `providers[]`，给无工具后台补全。缺席或失败不挡主会话。本切片唯一消费者是会话标题生成。ADR-0113。
_Avoid_: 第二套 provider 表；lite 缺席时 fail-fast 启动；把 compact / memory extract / dream 自动改接到这个槽

**rewind head**: 落盘的当前头指针（transcript 某条事件 id）。rewind 只改这个指针，不截断 JSONL。进程内工作副本跟它走。
_Avoid_: 只在内存里 fork；用 `messagesCount` 当下标 SSOT

**home 项目树（home project tree）**: harness 按项目身份落在池根下的一棵目录——`<dataDir 或 ~/.iknow>/projects/<slug>/`，slug 键 = **projectIdentityRoot**。叶子是 **会话文件夹**；同级 `tasks/` 是 **后台任务登记**；同级 `memory/` 是 **项目记忆库**。不跟 **workspaceRoot** 分片。ADR-0087 / ADR-0088 / ADR-0099。
_Avoid_: 把树建在 `<workspaceRoot>/.iknow`；把 `tasks/` 或 `memory/` 放进 conversation 叶子；把退役 `sessions/` 当成现行树

**会话文件夹（session folder）**: harness 拥有的按会话记录面——home 项目树下 `<conversationId>/`；装 session transcript / todos / trace / **内容寻址正文池** / subagents。与「写根 = 模型工作面」对立：这里的东西不是模型交付物，harness 也不把它读进 prompt。ADR-0071 / ADR-0087 / ADR-0088。
_Avoid_: 把模型交付物放进来；当第五个根角色（稳定根清单不活化）；用 session `title` / `goal` / worktree label 当文件夹名；把带锁活状态（后台任务登记表 / worktrees 锚点）搬进叶子

**后台任务登记（background task registry）**: 活账本 `…/projects/<slug>/tasks/<task_id>.{json,log}`，与会话文件夹同 **home 项目树**、不进 conversation 叶子。池根同会话池。ADR-0021 / ADR-0088。
_Avoid_: `<workspaceRoot>/.iknow/tasks`；按 checkout 分片；写进会话文件夹

**模型实际所见（what the model saw）**: trace `llm_call.messages` 的语义——那一次调用真正送进模型的累计消息集，含 `<agent_status>` 尾部注入、worker prior messages、compaction 后的摘要视图与 mask 形态。与 **session transcript** **故意不相等**（实测同一会话 `agent_status` 在 trace 14 次 / transcript 11 次），故 trace 不得引用 transcript 来重建它：从增量事件流重算累计数组是**重算不是查表**，会漂移。「所见即所填」不变量的 SSOT 是 ADR-0036（它据此否决 delta/off 写侧模式），不是 ADR-0014。ADR-0036 / ADR-0071。
_Avoid_: 用 transcript 当 trace 正文源；把两者当同一份记录的两种投影；为省空间截断它；把这个不变量溯源到 ADR-0014（那是 subagent spawn 语义，ADR-0036 误引）

**内容寻址正文池（blobs）**: 会话文件夹内的 `blobs/<sha256>`——正文 mask 后另存**一份**、定长 sha256 当文件名、`flag:"wx"` write-if-missing，读侧按 sha 取回原文。哈希在这里是**命名用法不是摘要用法**：原文一字不少地存着，没有压缩也没有丢失；寿命 = 会话文件夹，删文件夹即回收（承接 ADR-0036 悬置未细化的 rotation orphans 规则）。ADR-0036 / ADR-0071。
_Avoid_: 当全局共享池（那要自造引用计数 / GC）；当压缩或摘要；让 trace 引用 transcript 正文来代替它

**continue_pending**: 截断后在**同一会话**把未完成的工具环接着跑完——人对齐路径是 **`/continue`**（skip-append：不追加新任务 user）；有 pending 时的 NL 白名单是次入口。先对人停住（TUI 典型 **Esc**，2026-09-18 键位迁移前是 Ctrl+C）；`run` 前可对盘上 closeout 投影补悬空 `tool_use`。**本次**进模型的 prior 可去掉末尾 **interrupt system message**，盘上那句仍保留。空 Enter 不是续跑；忙着续跑只提示、不顺带 abort。**不是** ACI 工具。
_Avoid_: continue 工具；把空回车当续跑；续跑时从盘上删掉 interrupt；忙着 `/continue` 自动 abort；把续跑当传输重试；新建 session 挂旧历史；无确认自动续跑

**turnCount**: Foundation 运行时回合计数，每完成一个 assistant 回合（包括纯文本完成）加一；`maxTurns` 是在调用模型前检查的运行时上限。
_Avoid_: steps、retries

**stub model / stub tool**: Foundation 的确定性测试替身，覆盖真实模型或工具交通之外的完成、失败与停止行为；016 验 Gate A（S1–S11），017 起也验 Gate B required runtime layer（S12–S17 signal/timeout/trace），其中 `stub-signal-tool` 是 S17（ctx.signal -> AbortError -> execution_failed）的守门载体。不进生产装配路径。
_Avoid_: 声称已接入产品路径；mock agent、stub brain

**StopReason**: Loop Engine 的停止判别联合——016 五类（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse）末尾追加 017 的 `cancelled` 与 `timeout`，再追加 `fused`（本 run 工具环停滞，ADR-0029）；追加不重排，Transition 形状随之自动扩展。
_Avoid_: 把 cancelled 与 timeout 混为一条；把总耗时当作独立 stop 触发器；把 FaultClass 写进 StopReason；子代理把 fused 当成功

**FaultClass**: 并行于 StopReason 的失败策略闭集 `retry` | `fuse` | `none`（轴：API / 工具 / 上下文 / 控制流）；只决定传输重试与是否计入工具环，不回答 run 为何停。ADR-0029。尚无可见输出的 **model-call idle** / 请求超时与明确网络错、429/5xx 可落 `retry`；已有可见输出或已发出 `tool_use` 后的同类失败不自动重打。钟触发的 abort 不得标成 `user_cancel`。
_Avoid_: 与 verify 失败签名混名；与工具四 kind 混名；塞进 StopReason；把 idle 钟 abort 当用户取消

**tool-call loop detection**: 本 `run()` 内，工具阶段结果已追加进 append-only messages 之后、下一次 adapter.step 之前，用调用键与结果键做周期（k=1..5）重复 R=5 且停滞则 trip。ADR-0029。
_Avoid_: 连续 N=3 简化；verify 趋势停；sandbox violation kill；正文复读检测；settle 前取消同波 tool_use

**LOOP_DETECTED envelope**: 环检测 trip 时追加的固定模板 user 消息，写入权威 messages 并落盘，下一问作为 priorMessages 进模型；对人至少经 `stop=fused` 可见。
_Avoid_: 只 toast 不进历史；下一轮不喂模型；当成 tool_result 吞掉真实失败

**viewport API error**: 供应商/API/连接失败给人看的对话流行：薄外壳 `API error (status):` + 服务商原文；不追加进 **session transcript**，下一轮不喂模型。ADR-0094。异常停的底栏提示见 **sticky notice**。
_Avoid_: 把 `protocolError` / 「可能是连接或模型故障」当 UX 文案；把 API 失败落成 append-only assistant；与 sticky notice 混成同一条消息气泡

**wire model**: Anthropic SDK 请求体里的 `model` 字段 = 注册表 `models[].id` 原文（路由 `provider/model` 第一个 `/` 之后）。provider `id` 只查 baseUrl / key，不上 wire；需要前缀时把前缀写进模型名。ADR-0094。
_Avoid_: 把 provider id 自动拼进请求；把路由 ID 整段当网关模型名

**LoopTrace**: `run()` 的第二返回面 `{ result, trace }`（TurnTrace / Totals 两型）—— A 层结构元数据 trace（每回合 supplierStop / toolCall kind / durationMs / cancelKind + 一次性 reduce 的 totals），严格不含 payload；与 append-only messages 唯一权威解耦，immutable 累积。`cancelKind` 是取消来源四值枚举 `"none" | "callerAbort" | "timerTimeout" | "hostCancel"`.
_Avoid_: 在 trace 里塞 input/output/token/cost（B 层字段）——该禁令仅对 LoopTrace 本体，不外延到 TraceService（`LlmCallRecord` 承载 token usage 是 ADR-0008 裁决的合规落点）

**usage (token accounting)**: LLM API 每次成功调用回传的 token 计费（`inputTokens`/`outputTokens` 必填 + `cacheCreationInputTokens`/`cacheReadInputTokens` nullable，对齐 SDK `Usage`）；权威落点 = TraceService `LlmCallRecord`（观测真值，错误分支整条缺席），运行时暴露面仅 `RunResult.lastUsage`（TUI 显示读者，017:67 的有记录例外）。chars/N 估算永不进核算 / 显示；闸侧只在无实测 occupancy 时作后备（ADR-0008 / ADR-0118）。
_Avoid_: 用估算值顶替 trace 真值；为无读者的账本建运行时承载面；把 usage 塞进 LoopTrace

**context usage (display)**: 上下文用量显示 = TUI `ContextBar`（`src/tui/context-bar.tsx`）+ Web `UsageChip`（`web/src/components/UsageChip.tsx`，挂在 Composer）共同消费 `RunResult.lastUsage`（ADR-0008 D5）；wire 字段 = `TurnAnswerDto.lastUsage?` + `HealthResponse.contextWindow`（`src/session-api/` 投影，web 镜像于 `web/src/api/types.ts`）。百分比分子 = **context occupancy**；分母 = **策略预算窗口**（来源 `env.compress.contextWindow`，env var `IKNOW_MODEL_CONTEXT_WINDOW`，默认 256000）；Running 时按 **call-beat** 显示：读数 = 最近一次模型调用发出前的实测输入占用（`context_usage` 流事件 pre_call），或该次调用成功结束后的 API usage 校正（post_call）——随每次调用更新，不等整轮 `run()` 结束；同一次调用期间条可保持调用前值（检测在调用前，不在生成中途刷输出 token）。会话曾有成功 usage 时，`attachSession` / Web load 从会话文件回放的 lastUsage 或最后一条 agent answer 的 `lastUsage` 带回读数，重开不显示 0%。
_Avoid_: ContextUsageStrip；用 chars/N 估算顶替 lastUsage 真值（无成功 usage 字段缺席或 null，条画 0%）；为显示引入第二份 token 账本；让 contextWindow 走 `deps.compress`（避免触发 auto-compaction 行为变化）；用供应商 1M 卡当分母；在生成中途按已输出 token 刷条；把 countTokens 总量再加 cache

**viewport mount**: ChatView 只把 scrollbox 当前视口加 overscan 内的 transcript 条目挂进 OpenTUI 树；滚动文档仍覆盖全量 `session.messages` 与方案 B banner，高度来自布局实测。
_Avoid_: 固定条数尾窗；行账 / 行窗口；把 LLM `/compact` 当 UI 树裁剪

**fence display cap**: TUI markdown 围栏在 OpenTUI 树上只挂前 32 行，溢出用 `+N more lines`；会话正文仍是全文。与新建文件 10 行预览、编辑 diff 分开。
_Avoid_: 用只挂最近 N 条消息代替围栏截行；把围栏窗改成写预览帽；为省树而删 session 里的代码

**result preview（结果预览）**: 工具标题下的截断输出窗：先做 **progress tick** 再取 bash 尾部最多 3 行（ANSI 透传）；live 完成态与成功落定的 bash 都画。装饰不用每行 `>`，溢出 `… +N 行` 无箭头；失败走 **failure overlay**；`meta` 旁路不进模型。
_Avoid_: 每行 `>`；失败或 retract 仍画预览尾巴；把 meta 经 encodeToolResults 带进 model tool_result；与围栏或写预览帽混用；百分比流按行追加进气泡

**progress tick（进度覆盖）**: `Updating files: N%` / `1%`→`100%` 同一过程只占一行，留当前或最后一跳给人看；`\r` 原地覆盖与连续百分比行都折成这一行。落定不留中间轨迹，也不把这类信息整段藏掉。
_Avoid_: 每一跳百分比占会话一行；把 Updating files 整段藏掉；把进度史当 bash 标题

**write create preview（新建预览）**: 新建文件落定后挂正文前 10 行 + `+N more lines`。不是编辑。
_Avoid_: 6 行帽；把新建预览套到 edit diff 上

**edit diff preview（改动 diff）**: 编辑/覆盖已有文件时，人必须看见**本次改动**的 diff，不套新建那 10 行帽。
_Avoid_: 编辑只露文件头 6/10 行；把改动当噪音收进计数；用整文件当绿块冒充 diff

**settled appearance（落定态）**: TUI 里工具从 live 转为 idle 之后的可见性策略——按类留下足迹、收回去、或点名着色。不是「有已完成工具就整轮折成计数行」。
_Avoid_: 一律折叠；把 live 过程叫落定态；D3 整轮藏标题；过程行加 `[运行中]` / `[完成]`

**activity block（过程块）**: TUI 对齐一条 assistant 消息的过程 chrome——一行标题加一个 **body slot**，live 与 settled 两态。块按消息追加，不把整轮收成一行。
_Avoid_: 整轮一行 stub；思考摘要与过程组两套时态叠画；Ctrl+O 当本切片

**body slot（正文槽）**: 过程块里唯一给正文的位置。思考仍在流时归思考；**live noise** 接手后归一行 dim 当前预览。有语义工具不占此槽。
_Avoid_: 思考字里刷工具消息；思考与 `⎿` 混排；web_search 预览塞进思考槽

**live noise（实时噪音）**: live 才进过程块的侦察（`grep` / `glob` / `read_file` / `read_image` / 列举 / 内部查询）。不是整张 retract，也不含 `web_search` / `web_fetch`。
_Avoid_: 把网络搜索当噪音；live 把所有 retract 折进 `calling`

**live signal（实时有语义）**: live 必须实卡的动作——keep / accent / 失败，以及 `web_search` / `web_fetch`（查询或 URL 一行 dim，不摊长文）。
_Avoid_: 有语义工具进 `calling`；search 只留计数不留查询

**adjacent weld（相邻焊接）**: 仅当思考与 **live noise** 之间没有正文、有语义工具、失败时，标题才写成 `Thought for …, calling/called …`。
_Avoid_: 中间有字仍焊回上一行；把 `web_search` 计数焊进思考行

**live tool line（过程标题）**: 过程块的标题行。思考阶段是 `Thinking…`；相邻噪音可焊 `calling` / `called`。有语义卡不走这行。
_Avoid_: `[运行中]` 前缀；工具还在跑就关仍在流的思考槽；把仍在流的思考钉在已出现的工具卡上面；把 `Thought for` 甩到消息尾巴当第二套摘要

**keep class（留）**: 落定后仍画出标题行的工具类（bash / write / edit / 会话动作）。bash 成功留命令 + 折叠后的 **result preview**；新建走 **write create preview**；编辑走 **edit diff preview**；挤档可只留 `Wrote N lines to path`。
_Avoid_: 成功 bash 只留标题把 Updating files 藏掉；只留 dim 预览尾巴；把标题藏进折叠计数；把本次改动折没

**retract class（收）**: 落定后不摊正文预览的工具类（读 / 多数搜 / 查询）。live 是否进过程块改问 **live noise**，不是本表整表折进 `calling`。`read_file` / `read_image` 仍不摊文件内容（图不摊像素）；`web_search` / `web_fetch` 走 **live signal**。
_Avoid_: 给 `read_file` / `read_image` 加内容或像素预览；失败折进计数；把 retract 等同于 live 全折

**accent class（点名着色）**: 落定后以非 dim 的 `accent` 色 + 人读表述留在屏幕上的特定能力（skill、task worktree 生命周期工具）。必须进显示注册表。
_Avoid_: 浅色隐藏；只进计数；用 error 红当点名色

**failure overlay（失败横切）**: 任意落定类在失败时覆盖成功态分类——留标题、一行短错误、error 色、不进折叠计数、不用 dim `⎿` 堆长文。error 色优先于 accent。
_Avoid_: 失败跟成功走同一收；把失败当成第四类工具表；失败五行走 dim 预览

**thinking duration（思考时长）**: assistant 消息的落盘属性——adapter 流式路径测量（首条 `thinking_delta` 至首个非思考增量），`thinkingMs` 经 commit 钩子随事件链落盘，`SessionFileV1` 上照 `messageCreatedAt` 模式重建并行数组（additive，schema 版本不升）。过程块时长 = 该条消息的 thinkingMs，不跨消息求和。
_Avoid_: TUI 墙上时钟副产物（只活当前轮/重启即失/跨会话串味）；挂在 thinking 内容块上（污染 provider replay）；旧会话回填；`thinkingMs <= 0` 或非有限数落盘（字段缺席）；整轮累加冒充一块

**unit fold**: 过程块落定标题 `Thought for <duration>`，相邻噪音才接 `called` 计数；无秒数且无噪音则不画、不回落 `[思考]`。思考结束就在当时那一行变成这条标题，后面的工具或正文接在它下面。
_Avoid_: 结束态两套时态叠画；把 web_search / keep / skill 折进这行；中间有正文仍焊工具计数；多段思考并成一条秒数；整轮焊成一行

**open unit（未关闭簇）**: 当前仍 live 的那一块过程块——思考还在流，或噪音仍 `calling`。已冻 stub 不是关掉下一块思考的信号。
_Avoid_: 整轮 idle 当折叠粒；`currentTurnHasFold` 关后续思考；折叠存在即吞 live 标题

**live activity group（过程组）**: 已退役的进行中摘要形态（Listing / Reading / Searching 独立行）。噪音走过程块正文槽，有语义工具走实卡。
_Avoid_: 恢复 Listing 行；把 web_search 折进 `calling`；Ctrl+O 本切片

**skill-load display projection**: 给人看的 skill-load 是 `loading skill <name>` 芯片，外加用户 remainder（若有）；SKILL 正文只留在进模型的 skill-load 信封里，不画成 user 气泡。
_Avoid_: 把 `[skill-load name=]` 正文当作用户键入；加载技能；turn 结束后用落盘信封替换显示占位

**chrome focus**: TUI 底栏焦点环 `input` | 子代理行 | `graph` 的单一 reducer；有子代理行时 Down 先入该列，再 graph；Up 反向回到输入框。子代理行聚焦时 **Ctrl+X** 强杀该子代理（父 turn 收到 cancelled）；无聚焦则空操作。
_Avoid_: 只有 graph 抢 Down；焦点落在 ContextBar；子代理面板不可聚焦；位置行进焦点环；Enter 钻进子代理会话；第二套 picker 文案

**subagent card live（子代理会话卡实时行）**: `spawn_subagent` 画在会话那张卡上：live 为角色行加一行 dim 任务概述（`taskPreview`）；**completed** 后概述留下，其下绿 `✓ Done`，不再写 `running...`。位置在该消息下，不在输入框上方。failed 走该卡 **failure overlay**。角色行 = catalog id（`subagent_type` / `SubagentInfo.role`，缺省 `general-purpose`）；task 正文里的 `ROLE: implementation worker` 不是角色。同一 worker 不得再并排一张未 join 的 `general-purpose running`。
_Avoid_: identity strip above prompt；完成后用 `done` 替换概述；完成后仍 `running...`；绿 Done 走 failed；完成态 done 跟底栏面板一起淡出；把 task 里的 ROLE 文案当 catalog；已 join 的卡旁边再画一条 fallback 运行行

**前台打断**: TUI **Esc** 停当前会话全部前台——父 `running-fg` turn，以及本会话所有前景（`wait:true`）子代理，包括父已 idle 但仍 live 的；后景 `wait:false` 与其它会话 `running-bg` 不停。双击 Esc（≤1000ms）是回退选择器，前台有活时第一击先打断（2026-09-18 键位迁移：打断自 Ctrl+C 迁入，Ctrl+C 只剩选区复制；chat 视图外 Esc 由 list/mcp/graph 视图与各面板先消费）。Ctrl+X 仍可单杀焦点行（含后景）。_Avoid_: 只 abort 父 signal 留下前景子代理；idle 夹缝让前景子代理继续转圈；把 Ctrl+C 复制臂与打断绑回同一键；面板内重载 Esc 的返回/保存语义；把后景工人画成父 chrome「运行中」

**后景残留提示**: 父 **前台打断** 后 `runState` 必须 idle、输入解锁；仍 live 的后景（`wait:false`）工人只在 transcript 末尾 dim 英文标个数（`N background subagent(s) running`），不占「运行中」/「请等本轮结束」；终态仍经 **mailbox** silent wake 把父拉回 `running-fg` 收信封（底栏 SubagentPanel 仍可 Ctrl+X）。
_Avoid_: 把后景工人标成父 `running-fg`；把这叫 `running-bg`；打断后锁输入等工人结束；用中文「运行中」当后景计数

**session location chrome（会话位置行）**: TUI 底栏在 ContextBar 之下**常驻一行** `路径 · 分支`；绑 task worktree 只换同一行的路径。子代理与 Graph 在它下面（两者都有时子代理在上）；不进焦点环、不进模型消息、不带 dirty/diff。
_Avoid_: 绑树才出现；未绑树 0 行；用显隐当「在不在树上」；常驻第二行 dirty/diff；子代理画在位置行上面

**streaming block freeze**: 会变长的那串 markdown 里，除最后一个顶层块外钉住，后续增量不再 lexer、不再重建前缀子树；边界只前进。cancelled 模型在途 keep 与墙上同一刀：`prefixRaw` 进权威历史，`tailRaw` 丢掉。切刀落在 harness 可 import 的模块，不是 TUI 私有。ADR-0108。
_Avoid_: 把历史消息 memo 当成同一件事；每个新字整篇重解析；冻结时放开围栏 32 行窗；只给 TUI lexer 用、closeout 另按整步丢 assistant；harness import `src/tui`

**ToolExecutionContext**: Executor 透传给 handler 的执行上下文 `{ signal }`；run 第三参 signal 原样透传、不创建子 signal，超时由 Executor `Promise.race` 外包而非 ctx 携带。
_Avoid_: 在 ctx 里放 timeoutMs；为每个 handler 建子 AbortController

**per-call tool timeout**: ACI/executor 档位钟到点 → 只该条 `execution_failed` 且 `message` 为 `"timeout"`；loop **不**因此 `StopReason: timeout`。ADR-0091。
_Avoid_: 一波结果 `some(message==="timeout")` 升格为整回合停

**turn timeout**: 外层 `AbortSignal` 已 abort、且 cancelled 未抢先时的 `StopReason: timeout`。ADR-0091。
_Avoid_: 与 per-call tool timeout 混名

**in-flight closeout**: abort/timeout/进程死亡时的收尾。live：模型在途按 **streaming block freeze** 留下 `prefixRaw` 作本轮 assistant，丢掉还在长的 `tailRaw`（无 prefix 则不落 assistant）；工具在途则 assistant 已追加，在途 tool 填 `execution_failed`（`"cancelled"` / `"timeout"`），再编码为 tool_result。已闭合 `tool_use` 留下，未执行的走 cancelled 回填。signal 优先于 timeout。cancelled 另写 **interrupt system message**；resume/load 进程死亡未配对 `tool_use` 填 `"process"`，**不加** `Interrupted by user.`。mutating 工具须指示先检查副作用再重跑。一律走现有 `encodeToolResults`。ADR-0108。
_Avoid_: 模型在途把已钉住前缀整条丢掉；回滚已追加的 assistant 回合；悬空未回填的 tool call；把进程死亡当成 cancelled；只在墙上留前缀、盘上没有

**required runtime layer / conditional remediation layer**: 017 的两层对仗边界——required runtime layer（signal / timeout / trace / cancelled-timeout 停止 / in-flight closeout）已实施；conditional remediation layer（自动重试、checkpoint 落盘、token-cost 护栏、trace B 层字段、工具分类超时、错误分类细化、总耗时独立 stop、OTel 导出）017 显式禁止，推迟到 018 真实接通后按 013 条件式修复原则补。
_Avoid_: 把 conditional remediation layer 提前带入 Foundation 内核；用禁词扫描注释/JSDoc 代替可执行面能力边界（checkpoint 落盘在 session-api）

**executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段，executor 永不信任工具声称的截断字段（防 MCP 第三方伪造绕过封顶）。#140 裁决，ADR-0004 / ADR-0006。**scope 例外**：`skill()` 正文不在此闸内——它是装配产物（非可再生查询），豁免为内建装配期静态声明；MCP 工具结构性不可取得（ADR-0083）。
_Avoid_: 工具自填 truncated/total 字段；executor 凭工具标记跳过兜底截断；把 skill 正文豁免读成「工具可自证免截断」

**plain-string tool output**: (契约 Y1, deprecated→#298) 原生产工具输出为纯字符串（wire 边界同形态）；bash 例外保留 `{code, stdout, stderr}`（Y1b）。#298 起 Y1「纯字符串」读法被 observability side-channel 取代——model-facing tool_result 仍纯字符串（Y1 精神保留），但 handler 可返 envelope `{ output, meta? }`，`meta` 走观测旁路，永不进模型视野。#140 裁决，ADR-0004。
_Avoid_: 工具自填 structured metadata 进 model tool_result；把 bash 例外推广到其他工具

**observability side-channel**: (#298) 工具观测旁路——handler 返 envelope `{ output, meta? }`；executor 拆分后仅 `output` 字符串化进 model-facing tool_result，`meta`（典型如 edit_file/write_file 的 `oldContent`/`newContent`）经 `PostToolUseHook.payload` → `TuiToolEvent.payload` → `LiveToolRun` 字段供 TUI diff 预览等观测消费者，永不进模型视野。ADR-0004（supersede Y1）。
_Avoid_: 把 meta 拼入 model tool_result；让 TUI / Web 直接读 handler 原始返回对象

**ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；**基线 8 件**（`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`）之后按 append-only 批次增长（memory 2 / skill / subagent / todo / mcp / bg / run_graph / trace 读侧 / **符号工具面** 15 / worktree 5 / `read_image` …）。**当前件数以 `src/harness/aci/tools/registry.ts:ACI_TOOLSET_NAMES` 数组长度为唯一 SSOT，本词条不复述数字**（该文件自己声明「本表长度以数组为 source of truth」）。SSOT 工厂 = 同文件 `createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取（#141 / #191 / a277f68）。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。
_Avoid_: 在词条或文档里写死「当前 N 件」（必漂——曾写「当前 8 件 / 8+2=10」而数组早已 40+）；在 harness 之外另起 tool 注册表；在 entry point 手写工具数组；让工具返回结构化 metadata

**符号工具面（symbol tool surface）**: 模型面的 15 件 LSP 支撑工具——10 件查（`find_symbol` / `find_declaration` / `find_referencing_symbols` / `find_implementations` / `get_symbols_overview` / `get_hover` / `get_diagnostics_for_file` / `prepare_call_hierarchy` / `list_incoming_calls` / `list_outgoing_calls`）+ 5 件改（`rename_symbol` / `replace_symbol_body` / `insert_before_symbol` / `insert_after_symbol` / `safe_delete_symbol`）；以符号身份 `{ file, symbol_path }` 提问，行列译码封在 `symbol-resolver.ts`。#251 的 10 件坐标面 `lsp_*` 已在 symbol-primary-aci T5 从**模型面**退役，但**没有退役出代码库**——`createLspToolSet` 是 `scripts/lsp-probe.ts:266` 的真实栈烟测仪器（经 `package.json` 的 `probe:lsp` 接线），且 `renderNoServer` / `stringifyResult` / `isLspFailureSentinel` / `getClientForWorkspaceDetailed` 等共享件仍被活的 `symbol.ts` / `symbol-mutate.ts` / `symbol-resolver.ts` import。该文件是**名字起错**，不是死了。
_Avoid_: 把 `lsp_*` 当现行模型面；把 `createLspToolSet` 当死代码删掉（会砸掉 `probe:lsp`）；把只测 `lsp_*` 的断言当 `find_symbol` 等活路径的覆盖；让空数组兼任失败值（取不到 project 锚点应返分层哨兵，见 **请求级打开窗口**）；在 `symbol-resolver.ts` 外自写行列译码；grep 猜代码结构；靠 usage 让模型「优先」符号工具（职分靠 **替岗拒绝**，ADR-0117）

**工具职分**: `bash` 跑进程 / 构建 / git，ACI `grep` 搜正文，**符号工具面** 问程序结构；三件在 ACI 上同等可调用，职分不可替代。ADR-0117。
_Avoid_: 按谁更高级排序；把三件当同一 sink；用说明书当职分

**替岗拒绝**: 扮演他职的调用 fail-closed，回执只指向正职；放行证据认本会话工具轨迹（usage 三类回退），不认自觉。bash 段首 grep 族 / `rg` → 拒；ACI `grep` 命中**结构形**且无回退证据 → 拒。`sed`/`cat`/`nl` 行窗仍是读。实施验收 = worktree + **轨迹集**；对照树只允许「ACI `grep` 不闸」、同一集、比完只合入本政策。不是 **hard-wall**。ADR-0117。
_Avoid_: 源码扩展名启发式；警告仍执行；加长 usage；塞进 hard-wall；无黄金集成宣称完成；把未锚定 ident+`(` / `git grep` / 段首以外的间接 grep 写成必须拦

**结构形**: ACI `grep` 替岗闸认的 pattern 子集：冻结定义语法表（`function`/`class`/`def`/`impl`/`export` 等关键字、行首 `^` 绑 ident+`(`、修饰组），不是「这个调用像在问结构」。ADR-0117。
_Avoid_: 未锚定 ident+`(`；按语言扩展名推断；把表外关键字（Go `func`、Rust `fn`）默认当成结构形

**请求级打开窗口（request-scoped didOpen）**: tsserver 对未打开文件**不建 project**，所以符号类 RPC 必须罩在 `client.withDocumentOpen(file, run)` 里（进入开、退出关，含抛错与超时路径）——**这是 project 上下文的前提，不是性能优化**；请求间不对 server 保持打开，故 version 每次从 1 起算（`symbol-resolver` 缓存键改内容指纹即此推论）。例外只有**首次** `lsp_*` 同族调用触发的 warmup：裸 `ensureOpen` 置 `pinned = true` 永久持有一个**真实样本文件**，理由与本条同（`warmup.ts` / `client.ts`）；装配完成且从未调用这类工具则不起 language server。已知豁免口：`find_symbol` 的 `file` 缺省分岔用伪路径 `<directory>/iknow-workspace.ts` 仅为 spawn，随后裸发请求、不开窗口（`lsp.ts` / `symbol.ts`）。
_Avoid_: 把 didOpen 当可省的优化；跨请求保持打开（`pinned` 预热除外）；用伪路径当 project 锚点；把无锚点查询的空结果读成「真没这个符号」；用请求级 version 号当跨请求缓存键

**read_image**: ACI 读图工具。围栏内指定 `path`，魔数为 jpeg/png/gif/webp 且不超过 `read_file` 同档体积顶时，把 Anthropic SDK `ImageBlockParam`（base64）放进 `tool_result.content`。不入 last-read；`read_file` 仍拒二进制。
_Avoid_: 扩 `read_file` 出图；消息顶层 `type: image`；只认扩展名；工具层 vision 能力表；按 path 在 adapter 里 hydrate

**last-read ledger**: 本 conversation 内「看过的规范 path」登记表。**进程内存**，键为 conversationId，不落会话文件夹。入账：成功 `read_file`，或成功且可抽单一 path 的白名单 `bash`（`cat` / `nl` / `bat` / `batcat` / `head` / `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`；单文件、无管道、无重定向）。只供已存在且 size>0 的 `write_file` 查表，没有则硬拒不写盘；新建与空文件免检。`edit_file` 不查表。不扫 `ctx.messages`。无 conversationId 则非空覆写 fail-closed。resume 空表。ADR-0084。
_Avoid_: 用对话字符串判断读过；进程级全局表；落盘当权威；把任意只读 bash（`ls`/`stat`/管道）当入账；复用 `validateReadonlyCommand` 当入账；把 last-read 当作 `edit_file` 前置；把 `read_image` 成功当入账

**grep output mode**: `grep` 的出法枚举：默认 `paths`（只要相对路径）；`content` 为匹配行；`count` 为每文件条数加全库 total。结果名单条数参数为 `head_limit`（默认 50、顶 2000）。ADR-0084。
_Avoid_: 默认吐匹配行；把 `limit` 改名为 `grep_limit`

**line window**: `grep` 的 `also` + `within_lines`：主词命中后只在该行窗找第二段。不是裸跨行正则。ADR-0084。
_Avoid_: multiline 开关；`.*` 吞整文件

**install-rooted rg**: 安装根上钉死版本+校验和的搜引擎二进制；生产 `grep` 只 exec 这一路径。起不来走 Node 全语义扫，不回落 PATH `rg`。ADR-0084。
_Avoid_: which rg；环境依赖当主路径

**ACI network surface**: 装配层网络三职——发现是 `web_search`，阅读是 `web_fetch`，通话不升第 9 件工具、只走 `bash`（经 **出口代理缝** + **域名允许集**）。形状冻结；发现与阅读的后端选择见 **ACI web backend**。
_Avoid_: curl 工具; http_request; HTTP 原语; 把 method / headers 并进 web_fetch

**ACI web backend**: 发现与阅读共用一个后端名；该后端缺搜索或缺抓取时，缺的那一头回落到内建默认（搜索走现行默认检索，阅读走本机 `web_fetch` + `network-guard`）。
_Avoid_: 分设 search_backend 与 fetch_backend; 把缺的能力当成已接通; 缺抓取时改走 bash curl

**host-net amplify**: 已退役的 per-call 出口语义（旧 ADR-0022）——`bash` 带 `network: true` 且 ask 被同意后才摘 `--unshare-net`。现行默认见 **出口代理缝**。ADR-0022 / ADR-0097 / ADR-0107。
_Avoid_: 把 `network: true` 当现行输入字段；把 0106 围栏宿主网当现行默认

**围栏宿主网（fenced host-net）**: 已退役（ADR-0106，被 0107 取代）——曾把 bash 出网做成无域名闸的宿主直连。
_Avoid_: 当现行出口

**出口代理缝（egress proxy seam）**: bash 围栏 `--unshare-net` 之下唯一出网通路——宿主域名过滤代理；unix socket bind 进沙箱；**中继自带，不依赖宿主 socat**。`HTTP_PROXY` 系与 SSH ProxyCommand 都指这条缝。ADR-0097 / ADR-0107。
_Avoid_: apt 装 socat 当产品前置；名单内直连公网当过滤器；per-call 全开放行

**域名允许集（domain allowlist）**: 出口代理缝的放行判据——CONNECT/SSH 目标 host 命中才转发。全集 = **预放行档** ∪ 用户层 `isolation.network.allowedDomains`，`deniedDomains` 优先。ADR-0097 / ADR-0104 / ADR-0107。
_Avoid_: 删掉 settings 网络段当幽灵清理；与 network-guard 混成一条栈；开网无闸当允许集

**预放行档（builtin preset）**: 允许集的代码承载 defaults（GitHub 族、npm/yarn、PyPI、crates、Go module 代理、Playwright 下载）。模型供应商 API 与 Docker/GitLab 不入档。ADR-0104 / ADR-0107。
_Avoid_: 文档推荐配置当 preset；用「不进 preset」当唯一防 LLM key 手段却让 bash 无闸

**凭据 sentinel（credential sentinel）**: 围栏内假值、真值只在出口代理对放行域假换真（需 TLS 终止）。0107 **不自动启用**；可见面仍走 secret-roundtrip mask。ADR-0105。
_Avoid_: 与 mask 混名；当成 0107 必做面

**yolo 模式**: 用户显式确认的无沙箱姿态（TUI `--yolo` / `/yolo`）——无 bwrap 则无出口缝、无域名闸。`full_auto` 只免 ask，不免域闸。#1035 / ADR-0107。
_Avoid_: 把 yolo 当关域名闸；把 `full_auto` 当开网无闸

**声明工具面 vs 实际工具面**: `SubAgentDefinition.disallowedTools` 写进 `WorkerEnvelope` 的是声明面；worker 进程装配后真正可被模型调用的工具集是实际面，二者必须相等——裁剪发生在 `createAciRegistry(tools)` **之前**的 def-list 期（`createDefaultAciRegistry` 工厂内），由构造期快照保证，不事后修补（`AciRegistry.inner` 是冻结快照）。
_Avoid_: 给 `AciRegistry` 加 `.tools` 字段在产物上事后裁剪；声明 deny-list 但 worker 不消费（#468 修复对象）

**deps.system injection seam**: Each-turn 系统文本装配的唯一权威缝——loop-engine 调 `deps.system?.()`（`loop-engine.ts:358`），结果透传 `adapter.step request.system`；`undefined` 时不发送 `system` 字段（`anthropic-adapter.ts:577-580` 条件 spread），KV cache 前缀字节级稳定。装配主体是 `identity/assemble.ts` 的 `IKNOW_ASSEMBLY_ORDER` 流水线（#196）。
_Avoid_: 在 adapter 或 host 层直接拼系统；发送空串 `system`（KV cache jitter）；绕开 `deps.system` 在 adapter 内部二次组装

**memory_layer slot**: #196 9 段流水线 slots 5-9（user AGENTS / `PRIORITY_DECLARATION` / project AGENTS / `EXISTENCE_POINTER` / 可选 **memory_catalog**）收敛后的单 slot 名，位置仍在 bootstrap 之后；委托 #121 `createSystemResolver`（`memory/refresh.ts`：mtime 缓存 + inflight 去重 + 装配失败不毒化缓存），内部拼接顺序由 ADR-0009 锁定，目录段由 ADR-0034 追加，promote 段由 ADR-0044 撤出 system。#228 决议 D2。
_Avoid_: 逐 slot 独立消费缓存；再拆拼接后的整串；把拼接顺序拆出 slot 边界独立决策

**surface split (identity vs memory)**: 入口面（`chat` / `tui` / `ask` / `serve`）的两层语义——身份认知层（`identity` / `soul` / `user_profile` + 仅 chat/tui 触发的 `bootstrap`）恒在；记忆层（`AGENTS.md` + rules + 记忆库 + `memory_recall` / `memory_save` 工具）只对 chat / tui / serve 装配，`ask` 全 opt-out（`memory_layer` slot 不挂、memory 工具不入注册表）。#228 决议 D3。
_Avoid_: `ask` 全 opt-out（破"我是谁"答复路径）；`ask` 全 opt-in（破 #121 "ask 无状态"前提）；按 surface flag 同时决定两层

**auto_extract**（`settings.memory.autoExtract`）: 自动记忆抽取的产品总闸，boolean-only、**默认 OFF**——段缺失或非 `true` 一律关抽取与 **memory_catalog** 装配。`true` 时 host 仍按默认 **3** 个 `StopReason=completed` 抽，且梦境双闸满足时必跑梦境 LLM（即使 `settings.memory.dream === false`）。extract 与 dream 均关时仍可装配机械-only 钩子（**memory_gc** + **capability memory sweep**，零 LLM）；`ask` 仍不接线。ADR-0031 D1/D5 amendment 2026-09-11；ADR-0086；`specs/runtime-capability-memory-gate.md`。记忆 body 不进 `system`（ADR-0044）。
_Avoid_: 把默认改成 ON；开抽取却不要梦境；把记忆正文装进 system；把抽取 prompt 内嵌进 loop-engine；给 `ask` 接线；让 ingest 失败冒泡成用户 turn 失败；开抽取却不注 memory_catalog；双关时拆掉机械钩子以致假闸永不软禁

**memory_op**（`ADD` | `UPDATE` | `SUPERSEDE` | `NOOP`）: persist 仍认四态；**抽取** `decide ops` 只用 ADD / 保守 UPDATE / NOOP（无 CONTRADICTION_FLOOR SUPERSEDE）。`SUPERSEDE` 由梦境 `replaces` 点名后 persist 写出 `supersedes`，旧条仍经 **memory_gc** 软禁。三段函数分离不变。ADR-0031 D2 修订；`specs/auto-memory-layering.md`。
_Avoid_: 抽取再用低词重叠当矛盾作废；把四态压成 upsert；绕开 `memory_save` 写纪律；把三段合成一个函数

**memory_gc**: 可重复、幂等的机械清理，三条规则、**零 LLM**——`ttl_days > 0` 且已过期 → `disabled: true`；被别的条目 `supersedes` 指名 → `disabled: true`；活跃条目超 store cap → 按效用分 `importance × recency × (1 + recall_count)`（recall 次数取自既有 `usage.json` sidecar）从低到高软禁。与抽取共用默认 3 个 `completed` 闸，并可在进程退出 best-effort；同趟可跑 **capability memory sweep**。GC **只软禁不删文件**。ADR-0031 D4；`specs/runtime-capability-memory-gate.md`。
_Avoid_: 硬删文件；把 LLM 离线合并 / 摘要塞进 GC（合并走 **dream**，ADR-0033）；让 GC 依赖 frontmatter + usage sidecar 之外的运行时状态；会话开局同步全量 GC 挡首包；只靠人工打断（Esc）当唯一闸

**promote**: `usage.json` 里一条记忆被 ≥2 个不同 session 召回后的资格。资格只进入 **memory_gc** 效用，**不再**把正文装进 `system`；常驻说明书只在 `AGENTS.md`。ADR-0044。
_Avoid_: 用召回次数买 system 席位；auto-promote；把晋升当记忆进说明书的通道

**memory_type**: 事实条目 frontmatter `type` 的封闭枚举：`convention` | `decision` | `gotcha` | `constraint` | `note`。手动 `memory_save` 与自动 ingest 同一套；空或非法值收成 `note`，不 fail 写入。`specs/memory-layer-follow-ups.md`。
_Avoid_: 自由字符串当 type；自动与手动两套词表；非法 type 整次写入失败

**runtime capability persist gate**: persist 之前挡住「运行时能力/环境可用性」观测写成跨会话记忆（尤其 `type: constraint`）；`memory_save` 与抽取 persist 同一条闸，拒写是 typed 失败不是静默 NOOP。ADR-0086。
_Avoid_: 有用性品味过滤；短 TTL 当主药；改成 `note` 先塞进去；只靠 advisory 包装

**capability memory sweep**: 把已落盘的能力观测条机械软禁（`disabled: true`），与 **memory_gc** 同闸（默认 3 个 `completed`）并可退出尽力；读路径（prefetch / recall / catalog）在软禁前也不得把它们送给模型。ADR-0086。
_Avoid_: 开局同步扫全库；把作废还给会话内 `memory_save`；抽取 CONTRADICTION_FLOOR

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

**workspaceRoot**: session 绑定的 per-root 操作状态锚（settings 写回 fallback / worktrees）；配置解析器仍可按 ADR-0019 D1.1 以 `process.cwd()` 生成默认值，但 session 创建前必须把解析值校验并明确写入。serve 无 flag/env 时的默认绑定值是 `<homedir>/.iknow/default`。不含用户画像，不含 **home 项目树**（会话文件夹、后台任务登记与项目记忆跟 home，ADR-0087 / ADR-0088 / ADR-0099）。画像根见 ADR-0025。
_Avoid_: 用 workspaceRoot 当 `user.md` / `BOOTSTRAP.md` / 用户级 `AGENTS.md` / 用户 `rules/` 的物理根；把 identity seed 跟启动目录绑在一起；用它给 transcript / trace / tasks / 项目记忆 分片

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

**自动模式**: 权限轴 `PermissionMode` 的 `full_auto`：不逐次征求批准、对 mutating 工具直接放行的会话级权限模式；本轮不问人，跑完仍把键盘还给用户。hard-wall 仍先拦。Shift+Tab / 徽标上的 Auto 就是它。项目 settings 不得写入该值（`defaultMode: "full_auto"` 加载 fail-loud，仓库不得自授自动模式）。ADR-0032 / ADR-0090。
_Avoid_: 把 `/goal` 续跑叫自动模式；全自动模式；第三种 PermissionMode；项目 settings 自授 `full_auto`

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

**状态栏**: 每次即将调模型前由 harness 算出的现势，以 **user** 消息追加在 `messages` 末尾（含同一用户回合内 tool loop）；旧栏留在历史上，不替换、不写 `deps.system`；UI 只读同一份，in-flight 只给 TUI。字段：`last_tool`（本回合尚未跑过工具则为 idle）、`instruction:`（最新用户指令首行逐字回显，截断约 100 字符，代码计算不摘要）、有未勾项时才出现的 todo 段（只投影现行 todo 账本的未完成项，带 id 的 `- [ ]` / `- [~]` 行；文件缺席 / 空 / 全勾则整段缺席）、以及新用户消息进场后的一次性 reconcile 标记（提示模型先经 todo_write 对齐账本，仅该跳出现）。ADR-0028 / ADR-0103；todo 账本见 ADR-0085。
_Avoid_: 每轮替换/删除旧栏；写进 system；把 TUI 当主物；与 context usage (display) 混名；让 LLM 维护栏；把栏接入 verify；每跳塞任务摘录/cwd/技能清单；把用户指令摘要/改写进栏；reconcile 标记每跳重复；把调模型时的 in-flight 写进栏；taskFocus / 当前任务卡；空清单仍印 todo 段；全勾后栏里带 `- [x]`；用「本跳是否调用过 todo_write」当在场条件；政策散文进栏；把 **环境现势**（cwd/git/diff）塞进本栏；replace 当跳把新列表再灌进 messages

**todo 账本**: 同一**主会话**里可修订的任务清单；每条有稳定 id，状态 `pending` | `in_progress` | `completed`。三件事：批量添加、按 id 更新（含完成与删除）、读取现行。子代理与父共用这份账本（worker 可读取/更新，添加仅父会话）。`replace` 只是整表逃生口。现行文件仍是会话目录 `todos.md`。ADR-0085（修正 `0046-todo-ledger-replace-and-snapshots` 主路径）。
_Avoid_: 把清单并进 `run_graph`；进 plan 相位写计划再执行；同一文件里两套未勾项并存；换表当跳把全文追加进 messages；删掉旧账本文件；跨主会话共用账本；worker 静默丢弃 add

**环境现势**: 给人看的工作区快照（至少 cwd / git 摘要 / diff 要点），投放在 TUI（或等价）人读面；**不**写入 ADR-0028 状态栏 user 消息，也**不**充当 verify 输入。#655（G1）验收画像锁定。
_Avoid_: 状态栏；agent-status；把 cwd/git/diff 每跳追加进 `messages`；与 context usage (display) 混名

**沙箱纪律**: 同一 `bash` 调用输入下，前台执行与 `background:true` spawn 共用同一套 bwrap 围栏参数（FS / `--unshare-net` / env / rlimit / cwdReadonly；出网为 **出口代理缝**）；产品路径不得提供无围栏的后台裸跑。#653 G3 / ADR-0107。
_Avoid_: 把后台当成逃出 bwrap；与 #440 bash 产品面混名；与 spawn_subagent 前景/后景混名；把出网理解成 0106 直连无闸

**config 面板**: TUI 无参 `/config` 打开的设置浮层，交互同 `/model`（选行改值、Esc 落盘）。首版行：文件系统隔离档、worktree isolation mode、子代理并发上限预设。有参 `/config` 仍走 chat/serve。后续设置只加行。ADR-0096。
_Avoid_: 每个开关一个 slash；把面板当 loop-engine 热替换；把上限写进 system 前缀

**文件系统隔离档（fs isolation mode）**: bash 物理围栏上「能看见 / 能写哪些路径」的档位，与 **PermissionMode** 和 **worktree isolation mode** 正交。默认 **全局档**。ADR-0092 / ADR-0096。
_Avoid_: 把权限模式当围栏；把 worktree 门禁当 FS 档；第三种产品「沙箱模式」把两层揉成一档

**全局档**: 文件系统隔离关——宿主真路径可读可写；拦写靠权限三层 + **hard-wall**。home 不藏。ADR-0092。
_Avoid_: 默认闭世界；把全局档当成跳过权限链 / 卸 bwrap

**工作区档**: 读偏宽（home 可见）；写 = 活 **taskRoot** + **会话 tmp**；home 其余默认不能写。ADR-0092。
_Avoid_: 工作区档再藏 home；把工作区档写成闭世界；工作区档允许写整个 home

**闭世界围栏（closed-world fence）**: 已退役的默认 bash FS 姿态（ADR-0037 §9）：home 下非白名单**不可见**，可写集 = taskRoot + `/tmp`。默认改为 **全局档**（ADR-0092）。**工作区档不是闭世界**（home 仍可见）。
_Avoid_: 把现行默认说成闭世界；identity 只读 overlay（§9 已 superseded）

**会话 tmp**: 每个身份（主会话或一个 worker）在会话文件夹里的宿主目录；模型与 `$TMPDIR` 用这条真路径；不 bind 成 Linux `/tmp`。寿命跟会话文件夹；不是交付落点。ADR-0092（修订 ADR-0074）。
_Avoid_: 系统 /tmp；一次 bash 一块空 tmpfs；把垫底当仓库；围栏 /tmp 垫底（旧名）；给「按 id 读」另起产品名

**围栏 /tmp 垫底**: 旧名，见 **会话 tmp**。ADR-0074 原「bind 成 `/tmp`」已被 ADR-0092 superseded。
_Avoid_: 新产品面继续写这个名字当现行合同

**hard-wall**: spawn 前意图过滤器——拦围栏看不见或拦不住的命令意图（毁灭性 rm、命令替换、敏感路径、fork-bomb），不可被 session grant 覆盖。不是第二套沙箱；换行只作分段符。耐久写只问 `taskRoot`。ADR-0068。
_Avoid_: 把硬墙当沙箱；用换行/`format` 子串当危险；引导把交付物写到 bash `/tmp` tmpfs；把 **替岗拒绝** / 工具选型当硬墙

**compact reason**: 压缩路径分类，闭集 `below_token_threshold` | `messages_too_few` | `windowed` | `full_summary`，写入 `CompactSessionResponse.reason` 并驱动 UI 文案。`below_token_threshold` 只表示 proactive 未过 auto-compact token gate。
_Avoid_: 把手动 `/compact` 的 noop 写成「未达自动阈值」；UI 字面当业务码；reason 当 `LoopTrace` / `LlmCallRecord` 字段

**策略预算窗口**: `env.compress.contextWindow`——用量显示分母与 auto-compact 闸的同一数字；默认 256000。不是供应商模型上下文上限。ADR-0100。
_Avoid_: 显示一套窗口、压缩一套；把 `providers[].contextWindow` 或 1M 卡当默认分母

**context occupancy**: 用量条分子与 proactive auto-compact 闸的同一占用。pre_call（cache 字段缺席）= `inputTokens`（`countTokens` 总量）；post_call = `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`（Anthropic 三类不相交，null 当 0）。闸优先本拍有限且 >0 的 `countTokens`，否则上一拍 occupancy，否则 `estimateMessagesTokens`。ADR-0118。
_Avoid_: 显示一套分子、压缩一套 chars/4；把 countTokens 总量再加 cache；把缺测直接收成低于阈值

**auto-compact token gate**: loop-engine 在每次 `stepWithTrace` 前是否 **proactive** 压缩的阈值，含每个 `run()` 的第一次（prior 续传、`turnCount === 0` 不是豁免）；未设覆盖时为 `floor(0.95 × 策略预算窗口)`（`src/harness/compress/threshold.ts`），`IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` 可覆盖且必须 `< contextWindow`。不约束手动 `/compact`。比较的是 **context occupancy**，不是 chars 估算（无实测时才回退估算）。估算不进 trace / `RunResult.lastUsage`（ADR-0008 D6 显示半边 / ADR-0118）。
_Avoid_: 把该门当 `/compact` 许可；把字符估算当真实 token；gate 决策绕开 `evaluateCompactTrigger` 直接调 `shouldAutoCompact`；用 `window − 33k` 当策略预算缺省闸；用 `turnCount === 0` 跳过 proactive

**manual compact**: TUI `/compact` 与 web 压缩按钮触发的一次压缩；执行体与 proactive auto-compact **已开火之后**相同（窗口或 full_summary）。空会话幂等 no-op。
_Avoid_: 等到自动阈值才允许手动压；为手动另写一套压缩器

**task 取值公式**: 无统一 `??` 链。goal 功能判官 `task = goal.text`（无 fallback）；正常模式不设完成向 `task`。
_Avoid_: `goal ?? taskFocus ?? query`；`goal.text ?? query`；把 evidenceContext 拼进 task

**streaming arm**: LLM 客户端默认流式臂（`IKNOW_LLM_STREAM` 值域 `on | off`，默认 `on`，`env.ts` SSOT），`off` 回退非流式臂；原生 SSE 事件不出 adapter 边界，收敛为 `HarnessStreamEvent` 最小集（`text_delta` / `tool_call_start`，`src/harness/stream.ts`），终态经 SDK `finalMessage()` -> `interpretMessage`（SSOT）落为同形 `AssistantTurnResult`。
_Avoid_: 把 `stream: false` + 裸 JSON 解析当默认 LLM 臂；让原生 SSE 事件逸出 adapter 边界

**project stack defaults (SSOT boundary) — settings 单承载收敛 (ADR-0015)**: LLM 配置收敛到 `~/.iknow/settings.json`（user）+ `<cwd>/.iknow/settings.json`（project）双文件（ADR-0015）。项目层**不再**任意覆盖 user：只采纳允许名单（ADR-0084）。

- `settings.llm.model`（字面值，唯一来源，trim 后非空串）: **主会话**模型路由 ID 的全局可寻址位；缺失 → `loadIknowEnv` fail-fast 抛「no LLM model configured in settings.llm.model」，不再有 hardcoded 兜底。
- `settings.llm.liteModel?`（可选，同形 `provider/model`）: **lite model** 槽，见上条术语；缺失不 fail-fast。ADR-0113。
- `settings.llm.apiKey`（字面或 `${VAR}` / `$VAR` 占位符）: 唯一 key 承载。字面 → 原样；占位符 → 经 `expandPlaceholders` 从 `process.env[VAR]` 优先 / `.env.local` / `.env` 兜底解析。解析不到 → undefined（消费点守卫抛「no API key configured」）。
- `settings.llm.fallback?: string[]`: 用户自配的模型 fallback 列表（代码不预置任何 fallback）。
- `settings.llm.providers?: LlmProvider[]`: **LLM provider** 注册表——用户层键（项目文件不采纳，沿 ADR-0084）；每条含 `id` / `baseUrl` / `apiKeyEnv` / `headers?` / `models[]`（`id` / `name?` / `contextWindow?` / `maxTokens?`）；**仅 anthropic 格式**，baseUrl + apiKeyEnv 必填；`loadIknowEnv` 按 `settings.llm.model = "<provider>/<model>"` 拆头查表，命中 → `baseUrl = provider.baseUrl` + `apiKey = process.env[provider.apiKeyEnv]`（env 缺席 → 抛「no API key for provider <id>」）；**wire model** = 尾段 `models[].id`，不是整段路由。未命中 → fallback `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey`（今日路径逐字节一致，back-compat）。非法字段（id 空串 / baseUrl 非字符串 / apiKeyEnv 非字符串 / models 非数组）整条 drop，不静默。ADR-0093 / ADR-0094 / `specs/tui-model-command.md`。
  **退役机制**: `IKNOW_LLM_MODEL`（env 覆盖 model）已不再读取；`IKNOW_LLM_API_KEY_ENV`（env 覆盖 key 变量名）已不再读取；`LlmEnv.apiKeyEnv` 字段已删。`IKNOW_LLM_BASE_URL` 仍读（provider/baseUrl 是 9router 项目级决策，保留为代码默认 fallback）。`.env.local` 退化为「占位符真值源」（`.env.local` 持有 `${VAR}` 指向的变量值本身），不再是 model / key 变量名的配置口。
  **保留机制**: provider = 9router、`baseUrl` 代码默认 `http://localhost:20128/v1` 焊进 `env.ts`（`IKNOW_LLM_BASE_URL` 仍读）；非 LLM 字段（context window / maxTurns / web 端点 / mcp 超时等）的 `process.env > .env.local > .env` 优先级链不变。
  _Avoid_: 在 `.env.local` 重复声明已与代码默认一致的非密项；把 model 切换当「每机配置」而非「项目栈决策」

**`/model`(TUI)**: TUI 斜杠命令——打开 provider 注册表 picker（每项一行 `provider/model` + 当前项游标）；`↑/↓` 移焦点（clamp 首尾）、`Enter` 选定 + 持久化（写回 `~/.iknow/settings.json` 的 `llm.model` 路由 ID）+ env 重载、`Esc` 关闭且不持久化；provider 注册表为空 → typed notice。下一轮 adapter 用 **wire model**（`models[].id`），不是把路由整段送上网关。`/info` 仍显示路由 `Model: <provider>/<model>`。ADR-0093 / ADR-0094 / `specs/tui-model-command.md`。
_Avoid_: 把 `/model` 当 mid-turn 生效；空注册表时打开空面板；Esc 当"放弃选择"；把 picker 路由原样当 SDK `model`

**runtime LLM env**: 进程内 LLM 装配的唯一运行时源——一份 EnvLoader（`get` / `reload` / watch）。TUI 与 serve 同挂；`createAdapterFromEnv(loader.get())` 是唯一 adapter 工厂；thinking 覆盖只改入参，不另造 client。ADR-0094。
_Avoid_: hub 构造期 `overrideEnv` 快照；第二套 thinking client；serve 不挂 loader

**声明式权限规则**: 项目 `<仓>/.iknow/settings.json` 的 `permissions` 段用 `Tool` / `Tool(specifier)` 字符串（`allow` / `ask` / `deny` 三档 + 可选 `defaultMode`，值域 `default` | `plan`）；同项目层评估序 deny → ask → allow；编译为既有 `NormalRuleSpec` 进项目权限层，不新开决策轴。旧形态（`schema_version` + `rule[]` 谓词 DSL）加载 typed fail-loud、错误含新形态示例。模式名到 ACI 工具的映射、glob / param:value / Bash 复合命令分段 / 路径 specifier 形态见 `specs/declarative-project-permissions.md` Does。ADR-0090 / #1004。
_Avoid_: 沿用 `schema_version` + `rule[]` 谓词 DSL；写 toml 当并存 SSOT；项目层写 `full_auto`（加载 fail-loud）；让用户层接 `permissions`；用 param:value 匹配 Bash `command` / Read/Edit 路径 / WebFetch `url`；给规则手写 `id` / `reason`

**项目 settings 允许名单**: 共享项目 `<仓>/.iknow/settings.json` 只采纳 `verify` / `secrets` / `permissions`；`hooks` 仅用户层（command 钩子 = 任意 shell）。其余顶层段丢弃、不覆盖用户层。权限 SSOT = 项目 `settings.permissions`，规则形态 = **声明式权限规则**（ADR-0090 取代旧 toml 谓词 DSL），用户层不接；toml 与 json 并存 fail-loud。ADR-0084 / ADR-0090。
_Avoid_: 第三层 local settings；项目文件盖 isolation / llm / memory / subagent；用户 settings 写 permissions；继续读 `permissions.toml` 当并存 SSOT

**前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`，显式选项）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程，与前景/后景正交。
_Avoid_: 把前景/后景与进程隔离混同；泛化的"同步/异步"；把 V1"立即返回 task_id"当默认契约（已被反转）

**同轮多 spawn**: 并行工人 = 同一 assistant 消息里 N 次 `spawn_subagent`（`isConcurrencySafe`，同 wave 启动）。跨回合的 `wait:true` 会串行，这是前景契约。ADR-0101。
_Avoid_: 把跨回合单卡当成 TUI 丢卡；把默认改 `wait:false` 当并行定义；靠说明书逼模型跨回合先后景

**subagent_stop**: 父模型停本会话一名工人的工具；入参 `task_id`，内部 `abortTask`，与 Ctrl+X 同一杀进程路径。已终态/找不到返回结构化说明。ADR-0101。
_Avoid_: 复用 `bash_stop`；让模型直接碰 manager；把停当成续跑

**工人 transcript**: 工人自己的 session transcript——形状与主会话同一套 JSONL；落在父会话文件夹 `subagents/` 下，键 `(父 conversationId, task_id)`；工人 loop 边跑边 append。`listSessions` 不收录。不是 `agent-<taskId>.jsonl`（那是 per-agent **trace**）。本切片之前的派出没有这份文件。ADR-0102。
_Avoid_: 用 trace 当 resume 源；从 trace 倒灌旧工人；在项目池另开工人会话叶子；覆盖 `agent-<taskId>.jsonl`

**subagent_continue**: 父模型在工人**进程已死**且存在 **工人 transcript** 时，同一 `task_id` 再拉起（load rewind head + 下一句 user + `run()`）。`running` 拒。`completed` / `failed` / `aborted` 一视同仁。等待契约与 `spawn_subagent` 相同。ADR-0102。
_Avoid_: 往正在跑的 loop 里塞；用 TUI 有没有 `✓ Done` 当闸；新 spawn 一个失忆工人当续跑；保活旧 pid；只许成功交差后续

**子代理 task_id**: 这一次派出的 manager 句柄（`randomUUID()`）。父可见信封、`subagent_result`、mailbox、tmp、人停、`subagent_stop`、`subagent_continue` 都用它。worker `conversationId` 仍按 ADR-0040 管子侧。ADR-0101 / ADR-0102。
_Avoid_: 把 `task_id` 当父会话 id；用 worker `conversationId` 当父工具入参；续跑另发明一套父可见 id

**host drain**: host 把 completed 子代理的父可见信封浓缩成一条带固定前缀的消息、拼进下一次 `run()` 的 priorMessages；只读 buffer、不改状态。后景臂下：已有终态则立刻浓缩；仅 running 则立刻空返。叫醒主模型靠 mailbox，不靠用户再打一行，也不靠在 `run()` 边界空转等待。
_Avoid_: 把 drain 与"结果获取"混同（前景 spawn 不经 drain）；`wait:true` 已 tool_result 交差后再 silent wake 同一信封；让 agent 侧直接消费 manager buffer；把 drain 被动挂"下一轮用户输入"或阻塞轮询当作可靠唤醒源

**mailbox**: 后景 spawn 的子→父终态回传通道。只投终态浓缩结果，不承载运行中消息，也不是子↔子协议。
_Avoid_: 进度流；swarm / 子代理互投；把 mailbox 当 D-δ 低层 messaging；接到 run_graph 或图节点（ADR-0076）

**空跑**: 父模型在等子代理交差时自己 sleep、轮询 `subagent_result`、或编造状态。mailbox 叫醒主模型不是空跑。
_Avoid_: 把前景 spawn 把父绑在这一跳上当成空跑；用 bash 计时器当完成协议

**父可见信封**: 子代理交差给父模型看的那一层——短摘要、改过的路径、成败与停因、`task_id`、该 worker 的 `/tmp` 根，以及 host 在终态写入 pad 的终稿相对路径 `output_path`；短信封不是全文，`truncated` 不是任务失败。
_Avoid_: 把完整 result 当任务产物；把汇报截断当成任务失败；默认交差附带产物名单；靠子模型自己 write_file 才留终稿

**子代理并发上限**: 同时处于 starting/running 的 worker 硬顶；图节点计入同一顶。发几张由模型决定，超限立即失败、不排队。面板预设 `3 | 5 | 9 | 15 | unlimited`（`unlimited` = manager 不拒绝）。默认 15。现势给模型：工具 description 的当前 N + 超限 `SubAgentCapacityError`。ADR-0014 / ADR-0077 / ADR-0096。
_Avoid_: 静默排队；让用户每次填写要派几个；per-graph inflight 第二顶（ADR-0077）；把上限写进 system 前缀当唯一告知

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

**内置钩子（builtin hooks）**: harness 用代码装配的拦截或观测（如 `secrets.mode=block` 的 secrets-guard、TUI `onToolEvent` Post、violation 杀会话观察者）。不出现在 `settings.hooks`。各自仍走原产品开关（`settings.secrets`、host 是否传 Post 等）。
_Avoid_: 把 auto-memory / isolation / hard-wall 改挂成 settings.hooks 条目；用卸掉 settings.hooks 关掉 `/memory`

**用户钩子（user hooks）**: 用户层 `settings.hooks` 的 Claude command 组（`PreToolUse` / `PostToolUse`，`type: command`）。与插件 `hooks/hooks.json` 同一编译器；Pre exit 2 拦。项目层不采纳。不扫描 `~/.iknow/hooks/`。
_Avoid_: 与内置钩子共用 enable；项目 settings 写 command；旧 `{enabled, rules}` deny-only

**PreWrite (retired settings event)**: 曾为 deny-only 用户钩子事件（仅 mutate 调用）。已从 `settings.hooks` 移除；写拦截改由 command 脚本或 isolation 门禁承担。
_Avoid_: 在 settings.hooks 里再写 PreWrite

**PreCommit (retired settings event)**: 曾拦 `git commit` 形态。已从 `settings.hooks` 移除；改由 PreToolUse matcher + 脚本判断。
_Avoid_: 把 transcript commit 当 PreCommit

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

**stderr 指针**: worker crash 取证三件套的落盘形态——`subagent_stop.error` 结构化字段 + `stderr_path`/`stderr_bytes` 指针字段 + `<会话文件夹>/stderr/<taskId>.log` mask 后全量文件；父可见 summary 只留尾部 ≤2000 字符预览。归档 spec `docs/archive/025-retire-completed-specs-and-plans/specs/trace-agent-readability.md`。
_Avoid_: 把完整 stderr 内联进 JSONL 行；stderr 落盘绕过 SC20 mask；把 summary 截断当成诊断丢失

**blob 引用模式**: 已退役的 opt-in 开关名（曾 `IKNOW_TRACE_MESSAGES=blob`，默认 `full`）。现行唯一形态是 **内容寻址正文池**（content 级 `{role, content:{sha,bytes}}`，正文在会话文件夹 `blobs/<sha256>`）。ADR-0036 / ADR-0071。
_Avoid_: 当作仍可切换的存储模式；写仓库根 `<traceDir>/blobs`；整条 message 替换（role 被吃掉）

**tool_result projection**: 从已解引用的 `llm_call.messages` 抽出的工具结果摘要（`tool_use_id` / name / is_error / chars / preview）。供 `query_trace` 列表与下钻；**不是** `tool_call` 行上的 stdout 副本。`specs/query-trace-tool-results.md`。
_Avoid_: 打开 `resultCaptured` 往 tool_call 抄正文；把投影当会话账本；默认下钻倒 messages 全文

**role projection**: trace 读侧（`src/traceserver/` 共享核，ACI + MCP 两张皮共用）对 `llm_call.messages` 中 message role 的可见性投影——`query_trace` llm_call 行投影的 `last_assistant_preview`（最后一条 role=assistant 消息的预览，无则字段缺席）与 `get_record(detail=messages)` 清单臂每 part 的 `role` 字段；外部 agent 定位最终 assistant 结论不需盲翻 parts。plans/trace-mcp-role-projection.md。
_Avoid_: 改 `last_message_preview` 语义（它仍是逐字最后一条消息的预览）；把它当新增读侧工具（SC6 三件白名单不变）；在 `detail=tool_results` parts 上加 role（tool_result 按定义在 user 侧）；窗臂响应添 role（窗寻址已有 message_index）

**crash 取证无条件**: `subagent_spawn`/`subagent_state_change`/`subagent_stop` 生命周期事件与 stderr 指针文件在所有产品入口（含 chat REPL）落盘，与主循环 content trace 的入口开关解耦。ADR-0035（对 ADR-0003 D10 的范围修正）。
_Avoid_: 把生命周期事件绑回 `--trace-out`；把该扩张理解为 content trace 进 chat REPL

**worktree isolation mode**（`settings.isolation.worktreeOnMutate`，默认 OFF）: **用户层**写门禁开关——ON 时未绑树的 FILE_WRITE / root_flip 调用被拦前（门禁从不自动建树、回执点名 `create-worktree`）；bash 不预测拦——unbound 档围栏物理 `--ro-bind` 主 checkout，真写以 EROFS 违例回灌含同指引（ADR-0109）；OFF 时无门禁、主仓可写。工作树 ACI（create/enter/exit/list/remove）在 host 缝在场时**常注册**，不跟本开关捆死。`create-worktree` / enter / exit 成功才 **session worktree rebind**；bash `git worktree add` 不是 rebind。启动读取一次为初值；会话内可经 **config 面板**就地翻转并落盘（门禁每波读一次，翻转对下一次 tool call 生效——仍不 auto-provision）。ADR-0037（amended `specs/agent-control-surface.md`、ADR-0109）／ADR-0096。
_Avoid_: 默认 ON；门禁自动建树（auto-provision）；把工具在场等同门禁已武装；把建树当 host 职责而非模型调工具；把 git worktree 混成 serve 主根或 `workspaceRoot` 多根；config 层读 git 或持会话状态；改绑后隐式重载 settings；建树失败静默写主仓；只建树不改绑会话；同名树静默覆盖；项目文件覆盖 isolation

**session worktree rebind**: `create-worktree`（或 enter / exit）ACI 成功后，把**当前会话**的活 `taskRoot` 切到该树（exit 切回主仓）。与 isolation ON/OFF 无关：OFF 也可改绑；ON 只决定未绑树时写是否被门禁拦。bash `git worktree add` 不是本动作。只影响本会话。同一轮内对下一波 tool calls 生效。
_Avoid_: 改绑波及其它会话；把 rebind 当 serve 主根重绑；把 bash 建树当成 rebind；让 rebind 触发 settings 重载；要求操作员再发一条消息才生效

**task worktree label**: 给人/模型认树的 kebab 目录名。有合法 label 时叶子就是 `<slug>`，conversationId 不进文件夹（写在 gitdir sidecar；历史 `<slug>--<conversationId>` 仍可反演）。非法或缺席则叶子仍是纯 conversationId。同名已存在 → 建树失败不覆盖。
_Avoid_: 把 label 当 conversationId；用 session `title` / `goal` 当 slug；把 uuid 写进文件夹名当展示面

**worktree tool description（工作树工具说明书）**: 注册名是 `create-worktree` / `enter-worktree` / `exit-worktree` / `list-worktrees` / `remove-worktree`。description 先服务 agent：能不能调、做什么。人喊创建是第二层提示词 + 夹具；拦截点名是 harness。ADR-0082。
_Avoid_: `create-task-worktree` / `enter-task-worktree` 等旧注册名当模型面；把 `[worktree_isolation]` 写进 description；把 list 写成 create 前置；把「何时该调」政策写进 schema

**占用（worktree claim）**: 一棵 task worktree 被某会话占用，判据 = **现存会话记录里有别人的 `workspaceRoot` 指着它**；零新持久状态（不写锁文件、不加 sidecar 字段、不建注册表、不加跨调用内存 Map）。释放是 `exit-worktree` 的自动后果（该字段改回主仓根），或删除该会话记录；崩溃未 exit 的僵尸占用靠「恢复该会话让它自己 exit」解开（restart-safe adoption）。owner sidecar **只负责告知，不负责授权**。拦截仅在 `isolation.worktreeExclusive` ON 档生效，默认 OFF 且 OFF 档 enter 行为逐字节不变。ADR-0070。
_Avoid_: 用 sidecar 归属当授权或当锁；活性检测（PID 探活 / 心跳 TTL）；`release` 命令；`force` 覆盖参数；把排他当默认档；把占用与「写处境」告知耦成同一个开关

**worktreeinclude**: 位于 **projectIdentityRoot** 的 `.iknow/worktreeinclude`（gitignore 语法）。`create-worktree` 成功后只把「匹配且已被 gitignore」的**普通文件**拷进新树；目录跳过；文件缺席不失败建树。项目依赖不靠 include 拷 `node_modules`，见 **project dependency provision**。
_Avoid_: 拷 tracked 文件；递归拷 `node_modules`；把 include 当第二份身份根；include 失败阻断 provision；把 symlink 共享依赖树写成 include 语义

**taskRoot**（活值）: 会话当前生效的 task worktree 根——**写与工具 cwd 只问它**（写工具 / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录）。活性语义（`src/harness/session-roots.ts` 的 `LiveTaskRoot` cell）：**调用时读取**——所有消费点（门禁 shape 判定、写工具 resolve、bash 围栏、LSP directory、子代理 spawn 取根、环境现势）在 handler 调用时机读 cell 快照，不再闭包冻结装配期根；**唯一 writer = 装配层对 host `provision` / `enter` / `exit` 缝的包装点**（`withLiveTaskRootWrite`，缝成功 resolve 才写，失败不写不回滚、typed error 原样冒泡）；**batch 快照（一波一根）**——一次 `executeAll`（= 一波 tool calls）只在入口读一次，整波共用该快照，波内建树不把一次逻辑改动劈进两棵树。装配初值 = `SessionRoots.taskRoot`（未改绑时等于主仓）；`productRoot` / `projectIdentityRoot` / `installRoot` / mcpConfigRoot / stateAnchor 等稳定根**不**随它走。改绑后模型经 worker prior messages / path-outside 回执看见当前写根；消费 skill 时（slash 信封 / `skill()` tool_result / Web `getSkillBody`）只灌技能程序，正文不挂写根 trailer（ADR-0079）；告知面为 worker prior 与改绑后主会话一次，均按「写处境」三态渲染，`no_writable_root` 态只陈述事实、不点名 `create-worktree`（ADR-0069）；改绑后主会话经用户消息缝再给一次（非每轮、不进 system）；system `## Project path` 仍是身份根（`projectIdentityRoot`），bash 围栏把身份根恒进读白名单（closed-world fence）以保证「写仍不得进主仓」（ADR-0037 §9）。**叶子回显剥除**：根是树形时，写/读/改/搜的目标解析**先剥掉开头的叶子回显再解析**——模型常把树自己的 leaf 名当相对路径第一段回显（`ai-news-digest/index.html`），而树根已经是 `…/worktrees/ai-news-digest`；resolve 内一处谓词只认 `<leaf><sep>…` 与绝对 `<realRoot><sep><leaf><sep>…` 两种前缀（先归一化再判），裸 `<leaf>` 与非树形根逐字节不变。
_Avoid_: 闭包冻结装配期根（rebind 只在 run 边界重解析的旧实现）；第二写入口；一波内逐 call 重读（中途翻转劈两树）；把活 taskRoot 当 `productRoot` / 身份根 / per-root 状态锚（D3 稳定根清单不活化）；把「下一波生效」误述为「下一 turn」或要求 `/continue`；告知面无条件宣告「突变写该根」（隔离 ON 且未绑树时与门禁真值相反，见「写处境」）；相对路径再叠当前树 leaf 造成套娃目录；只在写工具里剥叶（读/改/搜重新套娃）；把裸 `<leaf>` 也剥掉；非树形根跟着剥；归一化后不重判前缀（`./<leaf>/…` 成为旁门）；剥完不再过 outside-root 拒绝

**写处境（write situation）**: 「此刻能不能写、写哪」的三态纯函数判定——`writable_main`（隔离 OFF，主仓可写）/ `writable_tree`（隔离 ON 且活 `taskRoot` 是树形）/ `no_writable_root`（隔离 ON 且非树形，无处可写）；判据 = 隔离开关 + **复用** `isTaskWorktreePath`，**不是**归属 sidecar（`enter-worktree` 四道检查无归属，会话可合法 adopt 外来树并被门禁放行）。告知面（worker prior / 改绑后注入）**共享此判定但不共享措辞**：`no_writable_root` 只陈述事实、不点名 `create-worktree`，点名留在门禁回执（意图已证）。skill 正文不挂写根 trailer。ADR-0069；告知面组成见 ADR-0079。
_Avoid_: 用 owner sidecar 当可写判据（会对 adopt 外来树的会话造反向谎）；重写第二份形状判断（shadow copy）；告知面与回执共用一份措辞；把 `no_writable_root` 写成祈使句；把 `/tmp` 短命事实塞进写根段（属 bash 面）；把写处境绑回 `skill()` 正文

**productRoot**: 每个产品入口首次装配确定的稳定主 checkout root；session worktree rebind 后保持不变，不随当前 task worktree 改写。
_Avoid_: workspaceRoot；task worktree root；product workspace 多根

**mcpConfigRoot**: 由 productRoot 派生、跨 session worktree rebind 保持稳定的 MCP 配置根；只读取 `<mcpConfigRoot>/.iknow/mcp.json`，不切换到 task worktree。
_Avoid_: workspaceRoot；task worktree；process.cwd()

**SessionRoots**: 会话四角色根 SSOT（`src/harness/session-roots.ts`）——`productRoot` / `projectIdentityRoot` / `taskRoot` / `installRoot` 一次按角色归位，消费者只消费返回值，不再自行拼 `join(cwd, '.iknow', …)`、读 `process.cwd()` 或自行判断 task worktree。`resolveSessionRoots` 是纯函数：不读 git、不碰文件系统、不持会话状态，缺根 / 空白 / 相对 / 不可规范化一律 typed fail-closed（`SessionRootError`），**绝不**回退 `process.cwd()`。
_Avoid_: 「三根」（实为四角色）；把 `resolveSessionRoots` 当有 IO 的解析器；让消费者自行拼 `.iknow` 路径；用 `workspaceRoot` 顶替角色分工

**projectIdentityRoot**: 用户此刻在做的那个项目的身份根，宿主启动时钉一次、跨 session worktree rebind 不变——**项目身份只问它**：rules / 项目 `AGENTS.md` / 项目 `settings.permissions` / 项目 skills 发现 / 子代理继承的身份根 / 记忆库命名空间名。与 `productRoot` 分开是因为宿主按 ADR-0019 从 `workspaceRoot` 取 `productRoot`，而 `--workspace-root <dir>` 重定向档下 `dir ≠ cwd`；取值由装配层决定（宿主钉的值优先，缺席时 `mainCheckoutOf(cwd)`），校验在 SessionRoots。
_Avoid_: productRoot；workspaceRoot；cwd；task worktree（身份根不可以是 task worktree，钉与不钉两条路径都过 `mainCheckoutOf`）

**installRoot**: iknow 运行时自身的安装位置（子代理 worker bootstrap 解析 tsx 与自身依赖），锚 `import.meta.url` 向上找最近 `package.json`，**不**锚任何会话根或 `process.cwd()`；进程级缓存、刻意不给 reset 缝（测试换安装根走 `opts.installRoot` 注入）。≠ 用户项目的 `node_modules`，故裸 task worktree 上 worker 仍能起。
_Avoid_: workspaceRoot；taskRoot；用户项目 `node_modules`；`process.cwd()` 相对解析

**project dependency provision**: `create-worktree`（及需要 ensure 的 enter）成功后，harness 在新树 cwd 按锁文件静默装**项目内**依赖（认 `pnpm-lock.yaml` / `bun.lock(b)` / `package-lock.json` 选安装器）；不装全局 runtime/CLI；不整树 symlink 主仓 `node_modules`。缺管理器、无 `package.json`、或安装失败 → fail-open（树仍在）并在回执写明。`specs/subagent-layers-worktree-deps.md`。
_Avoid_: 让模型猜包管理器再装；`npm i -g`；默认 `ln -s` 主仓依赖树；安装失败回滚 git worktree；与 **worktreeinclude** 混名

**dispatch lesson**: 给主代理的短英文调度课（explore 优先、并发上限由操作员工作流约束、隔离下先建树再写、技能走 catalog）；落在 `spawn_subagent` description 和/或小段默认注入，**不是**第二份项目说明书，也不焊外来 home 指令文件。改文案走 `docs/guides/prompt-development.md`。
_Avoid_: 第二份 CLAUDE.md；把整份 arthurpower 路由贴进 system；用课代替 capacity 闸

**model-call idle**: 单次流式 `adapter.step` 上「无模型输出增量」的静默上限；认 thinking/text/tool 增量则重置。默认分钟级。尚无可见输出到期 → 可走传输 `retry`；已有可见输出或已发出 `tool_use` → 不自动重打。约 20s 无字节只更新 **sticky notice** 的过程性「仍在等模型流」文案，不结算、不指控网络。
_Avoid_: 与 **model-call hardCap** 混名；与 LSP `idleTimeoutMs` 混名；120s 当产品默认真值；把 idle abort 标成用户取消；把 20s 当网络诊断

**model-call hardCap**: 同一次 `adapter.step` 从开始起算的有限墙钟；有增量也会到期。与 idle 到点在引擎侧可同收 `StopReason: timeout`，但归因仍是硬顶。
_Avoid_: 无限硬顶当验收；与 per-call tool timeout / turn timeout 混名

**sticky notice**: TUI 底栏/提示槽里异常停或传输过程的英文（或既有）提示框；默认不自动收回——人关掉、或主动开下一轮等明确动作才清。可在同一框内改文案（等待 → 退避 → 失败因）。其中「等待模型」这一条是**过程性心跳**：只表示模型相位还在、流上暂时没字节，不诊断网络。只在**模型相位**静默时给出；**离开模型相位**（`tool_call_start`，含 `spawn_subagent` / bash / 权限与 ask 等待）立即清除，成功收尾也清除；工具期既不新写也不继续显示。异常停 sticky 不受此影响。
_Avoid_: TTL 自动消失；与 **viewport API error** 气泡混名；重试成功后偷偷清掉未读失败框；把工具执行期算进模型静默；工具相位仍留着「等待模型」文案；20s 文案写 Check your network

**interrupt system message**: cancelled（TUI 典型 Esc，2026-09-18 键位迁移前是 Ctrl+C）收尾写入权威历史末尾的固定 system 文案 `Interrupted by user.`。普通下一句人话进模型时带着它；`/continue` 的本次 prior 可去掉末尾这一句，盘上仍保留。timeout 不加此句。
_Avoid_: 把 interrupt 当 closeout 的 tool_result；从盘上删除再续跑；timeout 复用同一句

**skill bare alias**: 插件技能规范名 `<plugin>:<name>` 之外，catalog 在无冲突时登记的裸名别名；`SkillCatalog.get` 先 canonical 再 bare。斜杠技能解析必须问 catalog，不在宿主再拆 `:`。展示与 help 优先 canonical。agents 不进斜杠。
_Avoid_: 在 `slash.ts` 自写第二套命名空间匹配；把 agent id 当 slash 技能；冲突时仍保留双份 bare

**技能模型索引**: 允许进入 `<available_skills>`（开场冻表或会话内增量）并允许 `skill()` 灌正文的资格集——有 description 且未 `disable-model-invocation`。开场投影冻在 system；新建名走 **技能索引增量**。ADR-0098。
_Avoid_: 用 `available()` 同时当 slash 候选；把无描述技能列进模型表

**可加载技能面**: 人 slash 能信封加载的全集——磁盘上有可加载 SKILL.md 的 catalog 条目，含无 description、含 disable。TUI / Web / CLI **同一个入口**。ADR-0098 / `specs/skill-index-increment.md`。
_Avoid_: 三宿主各滤一套；没描述就不能 `/`；用模型索引当 slash 列表

**索引进场史**: 本会话已经进入模型索引的 skill name 集（开场冻表 ∪ 已追加增量），跟 session 落盘。slash 信封不写入。compact 不删这份集合。ADR-0098。
_Avoid_: 只从当前 transcript 回放；把 skill-load 当进场；压缩后当没进过场再贴 listing

**技能索引增量**: 调用模型前接到 messages 最末的隐藏 user 消息，正文为 `<available_skills>` 且只含索引进场史尚未收录的模型索引行。ADR-0098。
_Avoid_: 整表刷新；插进本轮用户消息前面；画成用户气泡；改 system 冻表

**user-turn keep on protocol failure**: `protocolError` / `emptyFinalResponse` 时仍落下本轮**用户句**，不落下失败的 assistant。与「整轮不落盘」旧读法相对；`timeout` 落盘行为不变。
_Avoid_: 连用户句一起丢；把失败半截 assistant 当权威回复；与 viewport API error「不进 transcript」混成「用户句也不留」

**出站投影（model-facing projection）**: 发给模型的字节是由代码按消息来源投影出的**派生视图**——`buildMessageParams` 是 `LoopState` + `request.system` 的纯函数，同一历史 → 同一 wire 字节（KV 前缀稳定）；**append-only messages** 权威历史本身可以脏，假标签原样留在盘上只被出站转译。投影失败 fail-closed：本跳不发模型请求，不回落原样上脏。ADR-0112；对齐 ADR-0036 observability side-channel / 契约 X（磁盘真源 ≠ 模型可见字节）。
_Avoid_: 把「解析 XML / 前缀名册」当防伪机制；把转译结果写回权威历史或贴进 TUI 展示原文；指望投影阻止自然语言注入（那是能力面 sink 的事）；靠每跳改 `system` 塞现势

**宿主帧出处戳（host-frame provenance stamp）**: 宿主注入消息（状态栏等同款 `encodeUserText` 注入）在 commit 进 LoopState 时打的**非模型可见**标记，出站序列化时剥掉；它是官方外形的**唯一来源**——wire 上未转义的宿主帧语法只允许出现在带戳帧，无戳载荷一律确定转译到无法冒充。ADR-0112。
_Avoid_: 把戳当模型可见内容；让无戳 `tool_result` / user 文本复现未转义 host 语法；用 `isHostInjectedUserText`（服务 TUI 藏气泡 / instruction 回显）承担权威判定

**指令权威 vs 能力权威（instruction authority vs capability authority）**: 两层不互替的信任面——**指令面**（模型该认谁说的话是官方指令）靠**出站投影**拆假门牌，只信带戳宿主帧；**能力面**（模型实际能做什么）靠权限 / 沙箱 / egress 执法。拆了假门牌，普通句子里的「去做 X」仍可能被模型执行，那由能力层兜住。ADR-0112；承 ADR-0009 channel-based 信任、ADR-0044 低完整度来源不买 system 席位。
_Avoid_: 指望投影 / 转义挡住真实能力滥用；用 soul 告诫当验收机制（一行 usage 提示不承担 invariant）；把拆假门牌说成防越狱完成
**stream_incomplete (fault kind)**: (ADR-0111) `FaultEvent` 词汇表格——上游流结束但未产出完整 assistant message（空流/断流）的瞬时传输故障，**不是**协议损坏。带 `visible` 位（`clock_timeout` 同判据：本次 attempt 是否已有非空模型输出增量）：不可见 → 整 step 重试安全（D8 整回合不提交）；已出字 → 不自动重试，落 typed 失败。`nonClockFaultOf` default 支（protocol_error 压平）不删除只收窄，且命中时发 console.warn 诊断。
_Avoid_: 把断流归类为 protocol_error / crashed；对已出字的断流自动重试；删 default 支造成新形态静默逃逸；给 withTransportRetry 加第二套重试机（预算/退避全走既有机器）

**ModelStreamIncompleteError**: (ADR-0111) adapter 流臂把 SDK 断流裸 Error（`stream ended without producing a Message…`，按 message 形态 + 非 APIError + cause 链无网络错误识别）翻译成的 typed 错误；extends `ProtocolError` 故被 loop-engine 既有 `instanceof ProtocolError` 支干净收口（先例 `PromptTooLongError`），携 `visible` 与原 SDK 错误 `cause`。`transportApiErrorOf` 对它也提炼 apiError 摘要——不变式「apiError 在场 ⇔ 带 cause 的瞬时模型流/传输失败」。映射判据测试是 SDK 升级哨兵。
_Avoid_: 让裸 SDK Error 出 adapter 边界；本类子类支排在 `instanceof ProtocolError` 通用支**之后**（顺序惯例先子类，同 loop :1912）；把 apiError 当 UX 文案源（仍按 ADR-0094 薄外壳）

**modelTransient (envelope reason)**: (ADR-0111) 子代理 `SubAgentEnvelope.reason` 第五值（SC9 冻结四值的本 ADR 显式修订，freeze 测试期望 4→5）：上游瞬时可续失败（断流重试耗尽 / 已出字断流），区别于 `protocolError`（真协议损坏）与 `crashed`（进程级异常死亡）。发射点：worker 正常返回 stopReason=protocolError 时按 `RunResult.apiError` 在场分流 + run() 逃逸 catch 的本类 instanceof 支。failed + transcript 即可走 ADR-0102 `subagent_continue` 闸。
_Avoid_: 复用 protocolError+cause 字符串做父侧归因判定；把 exit≠0 无信封的崩溃改标 modelTransient；旧父跨版本收新值（ajv 拒 → 按现状 crashed）

**worker exit-2 专码**: (ADR-0111 成文化归档 spec 356 assumption 16/SC13) worker 进程 exit 2 **仅** = 信封协议错误（`parseWorkerEnvelope` 抛 ProtocolError，无信封可写）；run 阶段逃逸错误 → best-effort failed 信封 + exit 1；exit 0 + failed 信封 = 结构化失败按 reason 归因。父侧对 exit≠0 无信封标 `crashed`（SC16 支），契约原文只钉「exit ≠ 0」、2 是实现专码。SC13「父标 crashed」与 assumption 16「reason=protocolError」的微差按**分层**消解：无信封→crashed，有信封→按 reason。
_Avoid_: 任何产品/模型错误冒用 exit 2；把「exit 2 归还 SC13」读成契约钉死了码值 2；删改 envelope-freeze 断言代替显式修订授权

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
- **streaming block freeze vs in-flight closeout**: 同一刀切 prefix/tail；freeze 不是纯渲染优化（ADR-0108）
- **continue_pending vs in-flight closeout**: continue 只消费 `store.load` 的 closeout 投影补悬空 `tool_use`；不另写 sanitize 去删改 tool 对，也不把 closeout 本身当续跑口令；留下的 freeze 前缀仍在 prior 里
- **continue_pending vs interrupt system message**: 续跑可从**本次 prior**去掉末尾 interrupt；盘上仍有；普通打字带着 interrupt
- **continue_pending vs FaultClass retry**: 续跑不是传输重试；看不见输出的 idle/网络错才走 retry
- **sticky notice vs viewport API error**: 前者是底栏粘滞提示；后者是对话流行、不进 transcript
- **model-call idle vs model-call hardCap**: 静默窗 vs 整次 step 墙钟；到点都可收 timeout，归因分开
- **model-call idle vs LSP idleTimeoutMs**: 前者是模型流；后者是语言服务器连接池回收
- **project dependency provision vs worktreeinclude**: 前者装锁文件依赖；后者只拷小文件 allowlist
- **project dependency provision vs installRoot**: 前者是用户项目树依赖；后者是 iknow 自身安装根
- **dispatch lesson vs 说明书静态层**: 课是短调度；说明书是 AGENTS/rules，不是第二份路由全书
- **skill bare alias vs skill-load display projection**: get/匹配认 bare；给人看的芯片与 help 仍优先 canonical
- **user-turn keep on protocol failure vs viewport API error**: 用户句可留盘；失败 API 壳仍不喂模型当 assistant
- **状态栏 vs context usage (display)**: 状态栏是给模型的现势快照；context usage (display) 是给人看的 token 用量条
- **策略预算窗口 vs 供应商上下文**: 分母和 auto-compact 闸问 256k 策略预算；1M 真窗口只解释余量，不进百分比（ADR-0100）
- **状态栏 vs 环境现势**: 状态栏给模型（`last_tool` + open todos）；环境现势给人（cwd/git/diff），不进状态栏 user 消息（#655）
- **会话位置行 vs 环境现势**: 位置行是常驻身份（主仓/分支/树）；环境现势可以更宽，本轮位置行不带 dirty/diff
- **todo 账本 vs 状态栏**: 账本是磁盘现行 `todos.md`；栏只投影未完成项。replace 当跳不另灌列表；后续回合靠栏，不靠把快照拼进 messages（ADR-0085）
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
- **空跑 vs 前景卡住**: 空跑是等结果时的轮询/sleep/假状态；前景卡住是省略 `wait`（默认 true）时父这一跳绑到终态。后景完成靠 mailbox，不靠计时器（ADR-0014）
- **同轮多 spawn vs 后景 wait:false**: 真并行工人是同一消息里 N 次 spawn；后景是父不绑这一跳、结果走 mailbox（ADR-0101）
- **subagent_stop vs bash_stop**: 前者停子代理 worker（`task_id` / `abortTask`）；后者停 bash 后台进程组（`bg-` task_id）（ADR-0101 / ADR-0021）
- **subagent_continue vs 再 spawn**: 续跑装入同一 `task_id` 的工人 transcript；再 spawn 是另一个工人（ADR-0102）
- **subagent_continue vs subagent_stop**: 停杀 running；continue 只接已死且有 transcript 的（ADR-0101 / ADR-0102）
- **工人 transcript vs 工人 trace**: transcript 给 continue 的 `load`；`agent-<taskId>.jsonl` 是取证，不当会话历史（ADR-0071 / ADR-0102）
- **子代理 task_id vs worker conversationId**: `task_id` 是父侧派出句柄；worker `conversationId` 是子侧执行与 trace（ADR-0040 / ADR-0101）
- **graph mode vs PermissionMode**: graph mode 是编排 overlay；PermissionMode 是 mutating 问/拒/放行。进 Graph 冻结当时 permission，不把 Graph 写入 `PERMISSION_MODES`
- **开图提示 vs run 首短现势**: 翻转当拍可留一条长 ON/OFF；开着期间每个 `run()` 开头贴一次短「仍开着」，同一轮内环不再贴（ADR-0041 / ADR-0081）
- **图现势 vs system 前缀**: 开着/关着会变，不进 system；现势走用户侧每个 `run()` 一句，不靠抖 tools/system，也不单靠 compact 特补或每跳追加（ADR-0081）
- **run_graph vs spawn_subagent**: 有依赖的多节点走 `run_graph`；单次派活仍 `spawn_subagent`。图节点内部仍是前景 spawn，不经父代理再调 spawn 工具
- **run_graph vs 图内绕回**: 绕回仍走同一把 `run_graph`；阶段差在 host 认不认标明的回边，不在工具名（ADR-0061）
- **run_graph vs 后景 spawn**: 图没有 `wait:false`；跑图时父代理不能并行干别的，最多主进程静默等 settle；mailbox 不进活图（ADR-0065 / ADR-0076）
- **父可见信封 vs 磁盘产物**: 父读摘要、`task_id`、tmp 根与 `output_path`；终稿在 pad 上由 host 落；仓库文件仍以工作区为准，不靠把全文塞进 tool_result
- **会话 tmp vs taskRoot**: 会话 tmp 是当前身份草稿，不是交付；要留下的写 `taskRoot`，不自动从垫底拷进仓库
- **会话 tmp vs Linux /tmp**: 草稿走会话文件夹宿主路径与 `$TMPDIR`；不把垫底 bind 成 `/tmp`（ADR-0092）
- **文件系统隔离档 vs PermissionMode**: 前者是进程能碰哪些路径；后者是问不问人。全局档仍走权限链
- **出口代理缝 vs 文件系统隔离档**: 正交。FS 档管路径；代理缝 + 允许集管 bash 出网。两档 FS 网络行为相同（ADR-0107）
- **出口代理缝 vs host-net amplify**: 前者是现行唯一 bash 出网通路；后者是已退役的 per-call `network: true`
- **围栏宿主网 vs 出口代理缝**: 0106 直连无闸已废；现行是有闸的代理缝
- **network-guard vs 域名允许集**: `web_fetch` / `web_search` 的 SSRF；bash `curl`/`git`/`ssh` 走允许集
- **预放行档 vs 域名允许集**: defaults 是代码底档；允许集 = defaults ∪ 用户增量，deny 优先
- **secret-roundtrip mask vs 凭据 sentinel**: mask 管可见面；sentinel 需代理且 0107 不自动启用
- **文件系统隔离档 vs worktree isolation mode**: 前者是 bash FS 围栏档；后者是写主仓门禁 / 建树改绑
- **全局档 vs 工作区档**: 默认真路径读写；工作区档收紧为写 taskRoot + 会话 tmp，home 其余不能写
- **config 面板 vs `/model`**: 同族浮层；`/config` 管隔离与并发等运行档，`/model` 管路由
- **子代理并发上限 vs 派发张数**: 上限是帽子；张数由模型按任务拆，说明书写独立才并行
- **子代理并发上限 vs system 前缀**: N 会变，不进稳前缀；description 插值 + 超限回执是模型通道
- **图节点 vs 子代理并发上限**: 活图格子是同一顶上的 worker，不另起每图预算（ADR-0077）
- **说明书静态层 vs memory_layer 整段开关**: 通用 worker 要说明书、不要记忆工具；禁止再靠 memoryEnabled=false 把 AGENTS.md 一起跳过
- **状态栏 vs 任务摘录**: 摘录只在 compact 发生时现抽现贴至多 3 句用户原话；状态栏每跳由代码现算并追加，instruction 段只回显最新指令首行（截断）——两者都贴用户原话，但触发面与量级不同，均不经 LLM 改写（ADR-0103）
- **状态栏 vs append-only messages**: 栏走同一条追加纪律；纠错靠新栏，不靠从历史上抠掉旧栏
- **`memory_save`（显式写） vs auto_extract（自动写）**: 两条写路径共用同一套肯定句门禁、**runtime capability persist gate** 与 tmp+rename 原子写；显式写是模型当场决定的一次工具调用，自动写是 host 在 turn 完成后异步跑的一趟 ingest。差别只在触发方式与 `source: auto` 标记，不在信任通道——两者都只经 tool_result / prefetch 回到模型
- **runtime capability persist gate vs capability memory sweep**: 闸挡新写；sweep 软禁已有条；读滤在两步之间让模型当下看不见
- **capability memory sweep vs memory_gc**: sweep 认能力观测；GC 认 TTL / supersede / cap；默认同 3 个 `completed` 一趟，均可退出尽力
- **memory_catalog vs memory_prefetch**: 目录进 system（抽取开、库非空、短、稳）；预取进用户消息（每轮重算、最多 5 条正文、零词命中不贴）
- **memory_catalog vs promote**: 目录是短索引（通道是否仍进 system 见 ADR-0034 D1）；promote 是 GC 用的跨会话召回资格，不再提供 system 正文（ADR-0044）
- **memory_prefetch vs memory_recall**: 同一 `scoreMemoryEntries`；预取宿主先贴最多 5 条；recall 模型主动搜、默认最多 3 条原文（读通道不下令召回，spec casual-ask-context-hygiene）
- **dream vs auto_extract**: 字段仍是两个 boolean、默认皆 OFF。产品上 `autoExtract === true` 蕴含梦境（闸仍 24h ∧ 5）；仅 `dream === true` 且关抽取仍允许。钩子在 `autoExtract || dream` 时装配。都关则缺席。同一轮仍先抽取再梦境再 GC。
- **dream vs memory_gc**: GC 仍是零 LLM 的机械软禁；dream 是第二条 LLM 写路径，禁止进入 `gc.ts`。dream 落盘仍可被随后的 GC 按 TTL/cap/supersede 软禁
- **memory_gc vs promote**: GC 是机械减法（TTL / supersede / 超 cap → 软禁）；promote 资格只进入效用所用的 `usage.json`，不把条目装进 `system`（ADR-0044）。GC 不复活 `disabled` 条目
- **memory_gc vs memory_recall**: 软禁只改 `disabled`；`memory_recall` 必须在打分前丢掉 disabled 条，否则模型仍看到废条（`specs/memory-layer-follow-ups.md`）
- **stderr 指针 vs 父可见信封**: 信封 summary 只留尾部预览进模型视野；全量诊断在 stderr .log，经指针引用，不进模型
- **工具职分 vs hard-wall**: 职分是 bash / grep / 符号工具面各管一职；hard-wall 是围栏拦不住的危险意图。替岗拒绝走 handler，不进硬墙
- **替岗拒绝 vs usage**: usage 仍写三类回退；不变量由拒绝执法。加长说明书不代替本闸
- **结构形 vs 结构意图**: 闸认 ADR-0117 定义语法表（关键字 / 行首锚 / 修饰组）；未锚定 ident+`(` 是正文面，不是漏写的结构查询
- **blob 引用模式 vs 内容寻址正文池**: 前者是已退役开关名；后者是现行唯一落盘形态。messages 权威历史不受影响，TraceService 仍记录「模型实际所见」
- **tool_result projection vs tool_call.result**: 投影只读 messages；不把 stdout 抄到 `tool_call` 行
- **crash 取证无条件 vs ADR-0003 D10**: 生命周期三类事件 ≠ content trace；D10 的 chat REPL 排除只对 content trace 继续成立
- **git 作业 vs worktree isolation mode**: 作业是 bash 上的版本库侧效应；隔离是写路径落点（现行 model-provision，见本表 **worktree isolation mode**）。隔离开时作业在 task 树内做完
- **git 作业 vs 环境现势**: 现势给人看仓；作业是模型经 bash 改仓。现势不进模型消息
- **git 作业 vs git 块**: 作业是纪律 SOP（`## Git work`）；git 块是会话级分支/status 快照（`## Git`）。两段并存，不得互替
- **home 项目树 vs workspaceRoot vs 会话文件夹**: 项目树是池根下按 slug 的一棵目录（会话叶子 + `tasks/` + `memory/`）；`workspaceRoot` 是 settings 写回 / worktrees；会话文件夹只是项目树里的 conversation 叶子，不含登记表与记忆库。ADR-0088 / ADR-0099。
- **worktree isolation mode vs workspaceRoot vs workspace（serve 主根）**: git worktree 是会话级 mutate 物理隔离；`workspaceRoot` 是 per-root 状态锚（ADR-0019）；serve 主根是显式选定锚（ADR-0023）。rebind 只切本会话生效根，不改锚规则本身
- **session worktree rebind vs taskRoot（活值）**: rebind 是动作（缝成功 resolve 的那一刻），taskRoot 是该动作写入的活 cell；动作对下一波 tool calls 生效（波快照边界），cell 读取面始终回答「当前生效根」
- **task worktree label vs conversationId**: label 是文件夹名与 enter 定位；conversationId 是归属身份，不写进目录名
- **工作树说明书 vs 闸 vs 提示词**: description 先回答 agent 能不能调、做什么；写被拦点名是 harness；人喊创建是 usage/夹具
- **create-worktree vs create-task-worktree**: 模型面用前者；后者是旧注册名，不再给模型
- **前台打断 vs chrome focus**: Esc 停本会话全部前景子代理与父 turn；Ctrl+X 只杀焦点那一行（可含后景）
- **运行中 vs 后景残留提示**: chrome「运行中」/「请等本轮结束」只绑父 `running-fg`；父 idle 后后景工人只在消息末尾 dim 英文计数
- **running-bg vs 后景 spawn**: `running-bg` 是切走该会话 tab、父 turn 还在跑；后景是 `wait:false` 工人，父可以 idle
- **完成态 ✓ Done vs 替换概述**: 子代理卡 completed 后概述留下、其下 `✓ Done`；不是把第 2 行换成字面 `done`
- **父可见信封 vs host drain**: 前景交差是 tool_result 上的信封；drain 只服务后景 mailbox 叫醒
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
- **技能模型索引 vs 可加载技能面**: 索引给模型看/调 `skill()`；可加载面给人 `/`；无描述或 disable 只进人侧
- **技能索引增量 vs 前缀资格线**: 增量只许 messages 尾；开场表仍冻在 system
- **索引进场史 vs skill-load 信封**: 进场史只记模型索引名；信封灌正文不算进场
- **技能索引增量 vs 索引降档**: 降档只剥开场冻表；增量行带完整 description
- **写处境告知面 vs skill 正文**: 告知走 worker prior / 改绑一次；技能程序不附 trailer；写工具成功路径不另注写处境
- **hook router vs sandbox server**: 都是同进程装配；sandbox 管围栏执行，hook router 组合 builtin + settings command + plugin command
- **内置钩子（builtin hooks） vs 用户钩子（user hooks）**: 代码装配 vs `settings.hooks` command 组；卸 settings.hooks 卸不掉 builtin
- **用户钩子（user hooks） vs 产品开关（memory / secrets / graph / isolation）**: 正交；无 hooks.enabled 总闸
- **PreCommit vs session transcript 落盘**: PreCommit 拦 git commit 形态；JSONL append 仍是 host commit hook，不是 user 事件
- **闭世界围栏 vs 工作区档**: 闭世界是旧默认（home 不可见）；工作区档 home 可见、只收紧写
- **符号工具面 vs 坐标面 `lsp_*`**: 前者是现行模型面（符号身份提问）；后者已从模型面退役，但仍是 `probe:lsp` 的仪器（`createLspToolSet`），故测 `lsp_*` 的断言不构成 `find_symbol` 等活路径的覆盖
- **请求级打开窗口 vs warmup pinned open**: 前者随请求开关（退出即关）；后者是**首次** `lsp_*` 同族调用才裸 `ensureOpen` 对真实样本的永久持有，装配期不拉起 server；两者理由同一条（tsserver 不为未打开文件建 project）
- **分层哨兵 vs 空数组**: 拿不到 server / 根是**失败**，返 `(…)` 前缀哨兵并被 `isLspFailureSentinel` 认出；无 project 锚点返 `renderNoProjectAnchor` 哨兵——**不进**三前缀家族（调用打成了，消费者是模型：「结论不可信，换条路」）；`[]` 只许表示「查到了、真没这个符号」。缺方法哨兵不算失败（能力缺口）

## Flagged ambiguities

- **runtime vs optional local mirrors**: product runtime is standalone `iknow`; gitignored trees are never imported
- **ordinal vs ts**: log field is `ordinal` (1-based sequence)；不用 `ts` 表示 tool call 顺序
- **chat vs test harness**: product CLI is TTY/pipe-aware session code under `src/cli/`；单元测试调内部 helper 时不得声称这就是产品 UX
- **9router stack probe**: 同 key 可使 `models` 200 而 `chat/completions` 401；agent shell env 与 operator 交互 shell 可能不同（探针 `scripts/i4-probe-nine-endpoints.ts`）
- **streaming arm vs native SSE**: LLM 默认 SDK 流式臂（`IKNOW_LLM_STREAM`，默认 `on`，`env.ts` SSOT）；原生 SSE 事件不出 adapter 边界，host 只见 `HarnessStreamEvent`；`off` 回退非流式臂，网关响应由 SDK 统一消化，host 不直接解析 wire
- **turnCount vs harness maxTurns**: `turnCount` 统计每个已完成的 assistant 回合；`maxTurns` 是 run() 入口处的运行上限；二者不要混用
- **cancelled vs timeout**: 两条独立停止路径——cancelled 由 Loop Engine 检测 `signal.aborted`；**回合** timeout 只在外层 signal abort 且 cancelled 未抢先（ADR-0091）；单 call 档位钟只失败该条 tool_result。signal 优先，不在 signal 层合并超时
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
