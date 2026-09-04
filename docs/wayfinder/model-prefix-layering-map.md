# wayfinder:map — 模型面前缀分层与缓存兑现

> Tracker: 本地 markdown（用户裁定不开 GitHub issue；skill 默认 tracker 的 fallback 形态）
> Charted: 2026-09-03 · charting session 的 grilling 记录见 `## Decisions so far` D1 / D2
> 图名（人读引用时用全名，不要用裸 id）：**模型面前缀分层与缓存兑现**

## Destination

让 iknow 的模型面请求前缀（`tools` → `system` → `messages`）按**易变度分层**，做到会话内前缀字节稳定、从而命中目标端点的**被动前缀缓存**；**git 现势**作为该架构的第一个新住户按分层结果落位。

到达标志：每一段在前缀里的位置由它的易变度决定而非历史顺序；「什么有资格进前缀区」有可执行的纪律（不靠个人判断）；后续任何新段落地都有唯一正确位置可查。

> 措辞注记（2026-09-03，D4 之后）：原稿写的是「命中 Anthropic prompt cache / 断点位置有明确依据」。目标端点走被动缓存、没有断点可放，故改为「前缀字节稳定」。destination 的实质未变 —— 变的是达成手段从「放对断点」收敛为「不让字节变」。

## Notes

**domain**：harness 上下文装配（`src/harness/identity/assemble.ts`）、模型请求前缀（`src/harness/model-adapter/anthropic-adapter.ts`）、压缩（`src/harness/compress/`）、缓存。

**每个 session 开工前必读的 skill**：

- `arthurpower:logicsync` —— 所有 grilling 票的默认工作方式
- `arthurpower:domain-modeling` —— 本图预计产出 1~3 条 ADR（G2 / G4 / G5 都可能触发），走它
- `arthurpower:complexity-anti-drift` / `minimal-change-verifier` / `bounded-context-guardian` —— 触既有 ADR 的票必过

**并行 session 边界（2026-09-03 用户提醒）**：另有 session 正在优化 **worktree 工具**。本图**不改**任何 worktree 工具的形态；R5 是唯一触及它的票，且**只观察不改**。git 块相关的 T1~T3 排在最后，届时对方形态应已定型。

**本图必须尊重的既有决策**（不是本图要推翻的对象，除票内明确点名者外）：

- **ADR-0028** —— 状态栏以 user 消息**追加**在 `messages` 末尾、不替换历史、不写 `deps.system`。本图 G3 会**复用**它的论证（尾部追加不动前缀），不推翻它。
- **ADR-0013** —— reactive compact / prompt-too-long 回退。G5 会碰。
- **ADR-0030** —— graph overlay 运行期过滤 `promptTools`。G4 会碰。
- **ADR-0037 §4 / T9** —— `## Project path` 段读**稳定** `projectIdentityRoot`，rebind 不抖。本图**继承**这条，git 块与它同层。
- **IKNOW-196** —— 六段装配顺序 LOCKED（identity / soul / usage / user_profile / bootstrap / memory_layer）。G2 的问题就是「这条要不要改」，因此它是本图唯一被允许挑战的顺序契约。

**charting 期核实过的既有事实**（省下重复挖掘；冲突时以代码为准）：

1. `deps.system` 由 loop-engine **每 turn 调一次**，system 文本每回合现装配。
2. 全库 `cache_control` **零命中** —— 今天没有任何字节被缓存；适配器只读 `cache_creation_input_tokens` / `cache_read_input_tokens` 两个统计字段。
3. 全库 `context_management` **零命中** —— 服务端 tool clearing / compaction 均未接。
4. 装配顺序中静态段与易变段**交错**：最易变的 `memory_layer`（第 6）排在静态的 `## Project path`（第 8）**之前**。
5. 缓存规则（已核实）：前缀顺序 `tools` → `system` → `messages`；最多 4 个断点；断点前一个字节变则该断点及其后全废；前缀有按模型不同的最低长度门槛（512~4096 token），不够长静默不缓存。
6. `env-snapshot.ts` 已在真跑 `git status` / `git diff`，但产物只经 `env_snapshot` 流事件给 TUI 人读面，**不进 messages**（`loop-engine.ts` `appendEnvSnapshot`）。
7. **前缀构成实测（R2 / R3，2026-09-03 初测；2026-09-04 T0 修复后重测）**：生产工具面 42 件 = 42,178 chars ≈ **10.5K tok**；装配后的 system ≈ 5,170 chars ≈ **1.3K tok**（T0 修复后 usage 段已实际注入，+607 tok）。**tools 占整个前缀的 ~89%。** 详见 D3。
8. **目标供应商 = MiniMax + 火山方舟 Coding Plan 的 Anthropic 兼容端点**（用户 2026-09-03 裁定）。两家都是**被动缓存**（自动识别重复前缀，不需要 `cache_control`）。详见 D4 —— 这条把「断点放哪」整类问题移出了本图。
9. **`usage` 段从未注入（charting 期发现的 bug，见 T0）**：`usage` 是 `IKNOW_ASSEMBLY_ORDER` 的第 3 段、注释写明「恒在段，chat / tui / serve / ask 全部注入（SC1）」，但 `resolveSegment` 没有 `case "usage"` 分支，落到 `default: return undefined`。`IKNOW_USAGE_DEFAULT`（2,428 chars ≈ 607 tok，内容是「代码主路径走符号工具 / grep 三类回退 / edit_file 让位」）**在全仓库无任何 import**。即 `specs/symbol-primary-aci.md` T1/SC1 的交付物今天对模型不可见。

**记账修正（本图之外的立即动作，不占票）**：`docs/coding-agent-capability-gap.md` 第 100 行把「环境现势」整行记成「人读已补（刻意不进状态栏）」，导致**模型侧 git 感知从未作为独立缺口被开出**。该行应拆为两格：人读面 = 已完成；模型侧 = 未开工。另 `docs/design/DESIGN-ENVIRONMENT-PRESENT.md` 第 13 行「给人不给模型」应改为「人读面与模型面不共用流 / 槽位」—— 这才是它自己给出的论据（通道污染）真正支持的结论。

## Decisions so far

- **D1 · 模型侧 git 现势的投放策略** — 选 **A：开局注入一次快照，会话期间不刷新**，模型需要更新时自己跑 `git status`。块内必须带一句明示「这是开局快照，会话期间不更新」—— 否则模型会把几十轮前的 status 当成现状，那比不给更坏。rebind 造成的过期由 `create-task-worktree` 的工具回执自我纠正（新分支名已在 transcript 里）。否决 B（每回合刷新极瘦字段），理由：每回合追加会逐轮累加 token 面积，而过期代价可以靠一句免责 + 模型自查兜住。
- **D2 · git 块与架构的先后** — git 块**等**分层架构，不先发。理由：它虽然天然属于「会话内恒定」层（与 `## Project path` 同类，未来不需要搬），但用户裁定先把架构捋清楚再落住户，避免在未定型的结构上做加法。
- **D5 · 抖动源已定位为两条，且都不在 worktree 一侧**（R5 结论）— tools 数组会话内**会变**，`promptTools` 每轮现取、无冻结保护。活路径两条：MCP 异步连接（尾部追加，每会话早期 1~2 次，内建 10.4K 前缀仍命中）、graph 翻图（**中段删除** `run_graph`，破坏约半数工具 + 之后全部）。lazy 尾巴路径今天休眠，但它的「尾部追加不插回注册序」是本仓已有的正确纪律，G4 照它办即可。worktree rebind 走 `liveTaskRoot` cell、不重建 engine，**排除**在抖动源之外 —— 与并行 session 无需协调。
- **D6 · 易变不等于每轮；判据改为「一次抖动带走多少」**（R4 结论）— `memory_layer` 是 mtime 门控 + 记忆化，不是每轮重算；`user.md` 两周未动（每轮读盘但内容不变，实际是静态段）；`BOOTSTRAP.md` 不存在故段恒缺席。真实抖动只有两处：记忆落盘（每会话 1~~3 次）与 MCP 连上（每会话 1~~2 次）。**关键推论：system 侧的价值不在它自己那 0.7K，而在「它一变就把整条 messages history 的缓存带走」** —— 长会话里 messages 是全场最大的一块。据此把 G2 / G3 从「次要」上调为「中等」，D3 单看字节占比的排序在这一点上偏低估。
- **D4 · 缓存形态 = 被动前缀缓存，不做显式断点；本图收敛为「前缀字节稳定」一件事**（R1 结论）—
  - **MiniMax**（按量计费）：「自动缓存 / 被动缓存」自动识别重复前缀，**不需要改接口**；前缀按 **`工具列表 → 系统提示 → 用户消息`** 顺序匹配（与 Anthropic 同序，故 D3 的「tools 占 94% 且在最前」在这里同样成立）；门槛 **≥512 input tokens**；**写入缓存无额外计费**（与显式缓存不同，后者首次写入要加价）；过期时间由系统负载动态调整。官方明写「任何模块内容变化都可能影响缓存效果」。命中价 ≈ 输入价的 20%（如 M2.7：输入 2.1 / 缓存读取 0.42 元每百万）。
  - **火山方舟 Coding Plan**（订阅制）：Anthropic 协议端点 `https://ark.cn-beijing.volces.com/api/coding`；额度按**模型请求次数**计（Lite ≈ 1.8 万次/月，Pro 5×，按 5 小时 / 周 / 月三周期刷新），**不按 token 计**。? **前缀命中在这里只省延迟，不省额度。** 其显式 `Context API`（session / common_prefix + `context_id`）文档已标**待下线**，不作为路径。
  - **两条推论**：① `cache_control` 相关的一切（断点数量 / 位置 / TTL 选择）**不在本图范围**；本图的唯一杠杆是**让前缀的字节不要变**。② 本图的价值随端点分叉：MiniMax 侧是真金白银（输入降到 20%），火山侧是首包延迟 + 上下文窗口面积。两者都指向同一个动作，所以不影响 destination。
  - **证据强度提示**：MiniMax 的结论来自其官方 API 文档（`platform.minimaxi.com/docs/api-reference/text-prompt-caching` 与 `anthropic-api-compatible-cache`），可信。火山侧「代码缓存 / 推理缓存自动生效、不消耗额度」等表述来自 `volcengine.com/article/*` 的营销体文章，措辞含糊（且描述的像是**响应级**缓存而非 KV 前缀缓存），**未经官方 API 文档确认**；订阅制 + 按请求计次 + Anthropic base URL 这三条是可信的。若火山侧的省延迟收益要作为决策依据，需另开一张实测票（发两次同前缀请求量首包时间）。
- **D3 · 前缀构成实测 → 本图优先级重排**（R2 + R3 结论，assets: `scripts/wayfinder-measure-prefix.ts`）— 每回合无缓存重发的前缀里，**tools ≈ 10.5K tok（42 件，~89%）**，system ≈ 1.3K tok（~11%，T0 修复后 usage 段实际在场；初测为 0.7K / 6%）。**推论：断点必须先解决 tools 这一块；六段重排（G2）与易变段搬家（G3）争的是千余 token 的池子，只有在 tools 侧稳定之后才有边际收益。** 因此 R5 → G4 → G1（tools 尾断点）是本图的主干，G2 / G3 降为次要。单件最肥：`spawn_subagent` 836 tok、`bash` 489 tok、`get_record` 459 tok、`query_trace` 376 tok（trace 读侧三件合计 ≈ 1.2K tok）。
- **D7 · graph 切换的模型面表达 = A1：常驻注册 + handler gate + messages 尾部切换提示 + 编排段撤出 system**（G4 结论）— ADR-0030 的表达方式被 ADR-0041 修订，产品语义不变。翻图从此对模型面前缀零字节影响（tools 恒定、system 无模式段、messages 只尾部追加）。本图主干抖动表里「tools 中段变（翻图）」一行**消除**；剩余抖动源只有 MCP 连上（尾部追加）与 system 侧记忆落盘 / MCP 概览（见 D6 表）。附带产出 G1 的 tools 侧纪律形式：条件装配只许以会话级常量为闸门，可执行断言 = 相邻两轮 `tools` deep-equal。
- **D8 · memory_layer catalog 会话级快照**（G1 盘问中段裁决，ADR-0042）— operator 与 agent 合裁：`memory_layer` 的 catalog 段（+ promote 段同层）在会话首次装配取一次快照、会话内冻结，语义从「mtime 缓存」改为「快照」；bodies / prefetch 通道维持 ADR-0034 D2 不动。R4 抖动表「system 任一段变（记忆落盘）→ 全部 messages 作废，每会话 1~3 次」整行消除。悬置雾「auto-memory 写入时机与缓存边界对齐」随之消解（清出 Not yet specified）。
- **D9 · 前缀资格线 = 构造上会话内恒定；两条断言执法**（G1 结论，ADR-0043 §8）— 一段内容要有资格留在前缀区（tools + system），判据**不是实测变几次，而是输入来源构造上有没有会话内变化通道**：「实测没变」不算数（被动缓存无断点隔离，「碰巧稳定」与「保证稳定」同罚）。按线盘点 system 侧不合格仅 `memory_layer` catalog（→ D8 快照化）与 `<mcp_tools_overview>`（→ D10 撤出）。执法 = 两条断言：① `IKNOW_ASSEMBLY_ORDER` 声明↔产物一致性（补 T0 洞）；② 相邻两轮 tools + system deep-equal（D7 tools 侧 + 此处 system 侧合流）。
- **D10 · 工具面披露分层：内建常驻 + MCP 目录化 + 开局等待 + 溢出治理**（G1 + MCP 全链裁决，ADR-0043）— 内建核心件全量常驻永不延迟；**MCP schema 一律不 upfront**，名字目录进 system（首轮定稿）、完整定义经 `tool_search` 按需加载（结果消息 + tools 尾部双写、每件一次性抖动）；开局等待 30s（超时本会话缺席，窗口内零破坏进首轮）；手动重连成功**只消息追加**；断开不动历史；`<mcp_tools_overview>` 撤出 system。**溢出治理**：可延迟工具 schema 总量（countTokens 实测，禁估算）超过端点窗口 10%（配置读，不硬编码）时溢出部分退名字目录，仅首轮判定一次；退场次序 trace 读侧三件 → web_search/web_fetch → 其余低频件；核心件永不退场。R4 抖动表「tools 尾部追加（MCP 连上）」「system 任一段变（MCP 概览）」两行消除，正常路径每会话全量 messages 作废从 3~5 次降至 0。

## Tickets

> 本地 fallback 形态：一票一节。`state` 取 open / blocked / claimed / closed；`blocked-by` 为空即在 frontier 上。

### R1 · 目标端点的缓存形态

- type: `research` · state: **`closed`**（2026-09-03）· blocked-by: —
- 曾是整图 blocker；结论见 D4。

**## Question**

目标端点是否透传 `cache_control` 断点与 `context-management` / `compact` beta header？不透传时 destination 怎么改？

**## Resolution**

问题前提被推翻：目标端点是 **MiniMax** 与 **火山方舟 Coding Plan** 的 Anthropic 兼容接口，两家走的是**被动（自动）前缀缓存**，**不需要** `cache_control`。因此本图不做显式断点，收敛为「前缀字节稳定」一件事；`context_management`（服务端 tool clearing / compaction）在这两家均无支持证据，移出范围。完整结论与证据强度提示见 **D4**。

### R2 · 实测每回合发出的 token 构成

- type: `research` · state: **`closed`**（2026-09-03） · blocked-by: —
- asset: `scripts/wayfinder-measure-prefix.ts`（可重跑：`~/.bun/bin/bun run scripts/wayfinder-measure-prefix.ts`）

**## Question**

一次典型 TUI 会话里，每个 turn 实际发出的 `tools` / `system` / `messages` 各占多少 token？

**## Resolution**

`tools`：生产装配（tui/serve，全 host 缝在场）**42 件 = 42,178 chars ≈ 10.5K tok**（初测 41,706 chars；T0 修复后 tool_search 入常驻集 + schema 微调）；最小装配（ask 类，27 件）= 24,908 chars ≈ 6.2K tok。`system`：≈ 5,170 chars ≈ 1.3K tok（初测 2,740 chars ≈ 0.7K tok；T0 修复后 usage 段 607 tok 实际注入，见 R3）。**tools ≈ 前缀的 ~89%。** `messages` 未测（每会话不同，且它在断点之后，对本图的断点决策不构成输入）。token 数为 chars/4 粗估，仅用于判量级；精确值需读回包 usage 或 `countTokens`。结论进 D3，并因此重排本图优先级。

### R3 · 实测 system 各段的字节占比

- type: `research` · state: **`closed`**（2026-09-03） · blocked-by: —
- asset: 同 R2

**## Question**

`identity` / `soul` / `usage` 三个代码常量段各多大？装配后的 system 实际多大？

**## Resolution**

单段（chars / ~tok）：`identity` 75/19 · `soul` 1811/453 · `usage` 2428/607（T0 修复后**实际注入**）· `agent_status` 读规则 275/69 · `coordinator` 1344/336（默认不注入）· graph_mode on 切换提示（messages 尾追加形态）805/201 · readonly worker 的 tool constraints 2517/629。真实项目上 `assembleIdentityContext`（tui / bootstrapActive / memoryEnabled=false）在 T0 修复后产出 **5,170 chars ≈ 1,293 tok**（初测 2,740 chars ≈ 685 tok）。

**未测的三项**（本次装配缝缺席，留给 G2/G3 需要时再补，不阻塞主干）：`memory_layer`（需 build-engine 的 resolver）、`<available_skills>`、`<mcp_tools_overview>`。它们都在易变侧，而 D3 已证明整个 system 侧只占 6% —— 补测的边际价值低。

### T0 · 修复 `usage` 段从未注入

- type: `task`（AFK） · state: **`done`（2026-09-04）** · blocked-by: —
- **独立于本 destination 也值得修**；但它会让静态层 +607 tok，是 G2 的输入之一。已修复并重测：usage 段现实际注入，静态层 +607 tok，D3 / R2 / R3 数字已更新（R3b tui 装配 5,170 chars ≈ 1,293 tok）。

**## Question**

`resolveSegment` 缺 `case "usage"` 分支，导致 `IKNOW_ASSEMBLY_ORDER` 第 3 段永不渲染、`IKNOW_USAGE_DEFAULT` 全仓库零 import（charting 期实测，见 Notes 10）。修复即补回 import + 一个 case 返回该常量。

**## 调查结论（2026-09-03；本 session 只查不改）**

**根因链完整：是一次合并解决的「部分恢复」，不是从未接线。** 时间线（均在 `src/harness/identity/assemble.ts`）：

1. `5cddedd7`（08-31）—— **完整接线**：doc 注释 + `import { IKNOW_USAGE_DEFAULT }` + 顺序数组 `"usage"` + `case "usage": return IKNOW_USAGE_DEFAULT;` 四处齐全。
2. `4b4fa6fe`（09-01，`chore(retire)`）—— **六行全删**。该 retire 与 PR #862 在两个独立 commit graph 上并行开发，误删了对方仍依赖的东西（其自述已承认误删 worktree 三件 + 15 件 symbol 工具）。
3. `a893bae5`（09-01，`merge: origin/master — #862`）—— 冲突解决时**只带回了声明**（doc 注释 + 顺序数组条目），**没带回** import 与 `case` 分支。这就是今天的状态。
4. `b99492f2`（09-02，`fix(merge)`）—— 修的是 worktree 三件 + 15 件 symbol 工具的 `tool_not_found`；assemble.ts 的 usage 一行未动。

**为什么四步下来没人发现** —— 三件事恰好对齐：① 缺失的是一段 system 文本而不是一件工具，**没有 `tool_not_found` 这类显性症状**；② 现有测试（`tests/harness/identity/mcp-overview-segment.test.ts:166`、`coordinator-segment.test.ts:90`）断言的是 `IKNOW_ASSEMBLY_ORDER` **这个数组的内容**，而数组条目恰好在第 3 步被带回来了；③ **没有任何测试断言「顺序数组里的每一段都真的渲染出来」**。声明与实现分离，测试只看声明，于是丢失完全隐形。

**因此本票的修复不止补一个 case**（具体形态留给实施）：

- 补一条**可执行的不变式**：`IKNOW_ASSEMBLY_ORDER` 的每个元素都必须能在装配产物里找到对应内容，或被显式声明为「条件段」并给出缺席条件。当前形态下**任何未来新增段都可能以同一方式静默丢失** —— 这不是 usage 一段的问题，而且它直接威胁本图的成果（分层后新增的段同样只有声明没有断言）。
- 决定 ask 表面是否也注入（607 tok 对 oneshot 的性价比）。
- 修复后重跑 `scripts/wayfinder-measure-prefix.ts` 更新 D3 的数字（静态层 +607 tok）。

### R4 · 实测各段的真实变更频率

- type: `research` · state: **`closed`**（2026-09-03）· blocked-by: —

**## Question**

一次典型会话里各段实际变几次？「静态 / 易变」的分界线画在哪？

**## Resolution**

**结论：system 侧比预想的稳定得多，易变只集中在两处，且都是「每会话若干次」而非「每轮」。**

最重要的一条机制发现：**`memory_layer` 不是每轮重算的。** `memory/refresh.ts:createSystemResolver` 是 **mtime 门控 + 记忆化**：首次 `discover()` 建立 tracked 文件集，之后每次调用比对 mtime，未变就直接返回缓存的 `lastSystem`（**同一个字符串**）。所以它只在被跟踪的记忆文件真的落盘时才变。

实测数据：

| 段                     | 机制                             | 实际频率                                                                                                                                               |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity` / `soul`    | 代码常量                         | 永不变                                                                                                                                                 |
| `usage`                | 常量，但**当前根本不渲染**（T0） | 恒缺席                                                                                                                                                 |
| `user_profile`         | 每轮读 `~/.iknow/user.md`        | 文件 mtime = 2026-08-20（两周未动）? **每轮读盘但内容不变，实际是静态段**。「每轮读」≠「每轮变」，此前的分层假设在这里是错的                           |
| `bootstrap`            | `BOOTSTRAP.md` 存在即注入        | 该文件不存在 ? 段恒缺席，稳定                                                                                                                          |
| `memory_layer`         | mtime 门控 + 记忆化              | 写入**成簇**：实测簇在 08-28 16:49（5 文件）、17:02（6 文件）、21:17、09-02 22:46（含 `MEMORY.md`）、09-03 10:13 ? **一次会话内约抖 1~3 次**，不是每轮 |
| `## Project path`      | 稳定根                           | 永不变                                                                                                                                                 |
| `<available_skills>`   | catalog 快照                     | 会话内恒定（除非 skill 文件变）                                                                                                                        |
| `<mcp_tools_overview>` | 每轮现读 `manager.status()`      | 随 server 连上而变 ? **每会话早期抖 1~2 次**（与 R5 路径 A 同源同时刻）                                                                                |
| `agent_status` 读规则  | 静态一句                         | 永不变                                                                                                                                                 |
| `orchestration`        | gate 每轮现读                    | 默认关；仅用户翻图时变（人工触发，频率由使用习惯定）                                                                                                   |

**由此得到本图真正的判据 —— 按「一次抖动的代价」排序，而不是按段的大小排序**（因为前缀是 `tools → system → messages`，越靠前的一次变动波及越广，而 `messages` 在长会话里是全场最大的一块）：

| 抖动事件                                   | 波及范围                                | 频率                  |
| ------------------------------------------ | --------------------------------------- | --------------------- |
| tools 中段变（翻图，R5-B）                 | 约半数工具 + system + **全部 messages** | 人工触发              |
| tools 尾部追加（MCP 连上，R5-A）           | system + **全部 messages**              | 每会话 1~2 次（早期） |
| system 任一段变（记忆落盘 / MCP 概览刷新） | **全部 messages**                       | 每会话 1~3 次         |
| messages 尾部追加（正常回合、状态栏追加）  | 无                                      | 每轮                  |

? 合计每会话约 **3~5 次全量 messages 缓存作废**。**注意这条推论：system 侧的价值不在它自己那 0.7K，而在「它一变就把整条 messages history 的缓存带走」。** 六段重排（G2）与易变段搬家（G3）的真实收益因此不是省 0.7K，而是**减少 messages 缓存被带走的次数** —— 这比 D3 单看字节占比得出的「system 侧次要」要高一档，G2 / G3 的「次要」标记据此上调为「中等」。

### R5 · 观察：会话内 tools 数组是否恒定

- type: `research` · state: **`closed`**（2026-09-03）· blocked-by: —
- 只观察未改动任何代码；worktree 那条路径的结论是「不是抖动源，不用管」。

**## Question**

同一会话内 `visibleSchemas()` / `promptTools` 会不会变？

**## Resolution**

**会变，有两条活路径 + 一条已休眠 + 一条排除。** 前置事实：`promptTools?.()` 是**每轮模型调用前**取值（`loop-engine.ts:225` 注释 + `:1023` 调用点），装配期没有冻结保护；`visibleSchemas()` 现读 `[...tools, ...externalByExt.values()]` 再按 `aci.lazy` 过滤。

- **路径 A（活，每会话必发生）—— MCP 异步连接。** `mcp/manager.ts` 连上后调 `registerExternal(defs)` 把 `mcp__*` 写进 `externalByExt`，下一轮 `visibleSchemas()` 就多出这些工具。本仓 `.mcp.json` 配了 2 个 server（其一是 `npx -y aiterm-mcp`，冷启动必然晚于第一轮），所以**每个会话早期都会抖 1~2 次**。破坏范围：external 工具排在 42 件内建**之后**，所以内建那 10.4K 的字节前缀**仍然命中**；落空的是插入点之后的 system（0.7K）+ 全部 messages。
- **路径 B（按需触发，破坏最大）—— graph overlay 翻图。** `build-engine.ts:1031` 在图关时 `visible.filter(t => t.name !== "run_graph")`。`run_graph` 在 `ACI_TOOLSET_NAMES` 里约第 21 位（共 42），**这是中段删除**：翻一次图，从该位置起的字节全变 → 后面约一半工具 + system + messages 全落空（约 5K+ token）。
- **路径 C（已休眠，但是本仓的正确先例）—— discovered lazy 尾巴。** `grep "lazy: true"` 零命中，今天没有 lazy 工具，故不产生抖动。但它的实现**本就是为前缀稳定设计的**：注释写明「尾部追加而非插回注册序：相邻轮无新 discovery 时可见前缀逐位不变，保 KV cache 前缀命中」。**G4 可以直接照这条既有纪律办 —— 不需要发明新原则。**
- **路径 D（排除）—— worktree rebind。** 同一 run 内的 rebind 由 `liveTaskRoot` cell 完成（`withLiveTaskRootWrite` 写 cell），**不重建 engine、不重算工具面**；且 hub 的两处注入点（`hub.ts:2767` / `:2879`）都同时给出 provision / enter / exit 三缝，绑定与未绑定状态的缝集合一致。? 不是抖动源，本图与 worktree 并行 session 无需协调。

### R6 · 实测两端点的被动缓存是否真的生效、值多少

- type: `research` · state: `open` · blocked-by: —
- D4 派生。火山侧证据只有营销体文章，需要实测顶上。

**## Question**

对 MiniMax 与火山方舟 Coding Plan 各发两次**同前缀**请求（第二次只改末尾用户消息），量：(a) 回包 `usage` 里有没有 `cache_read_input_tokens` 之类字段、值是否非 0；(b) 首包延迟（TTFT）差多少；(c) 故意改动前缀最前面的一件工具 schema，看命中是否如预期落空。**这是本图的价值校准票** —— 若火山侧实测没有可观测收益，本图对火山的部分退化为「只省上下文窗口面积」，主干票的排序可能要再调一次。前缀需 ≥512 token 才够门槛（MiniMax 明文），拿现有 10.4K 的 tools 面天然满足。

### G1 · ~~断点放几个、放在哪里~~ → 前缀稳定的边界画在哪

- type: `grilling` · state: **`closed`（2026-09-04）** · blocked-by: — （R4 已闭）· 决议进 D9 / D10（ADR-0042 / ADR-0043）
- **本图主干**。D4 取消「断点」半边后，本票定了另一半：资格线 + 执法形式 + MCP 全链披露形态。

**## Question**

被动缓存自动匹配**最长相同前缀**，我们不能选边界 —— 边界由「第一个变了的字节」决定。所以本票要定的是：**哪些内容有资格待在前缀区（会话内绝不变），哪些必须被赶到前缀之后**，以及这条纪律怎么落成可执行的形式（类型约束？装配层断言？测试？）。注意与显式断点的关键差异：显式断点可以**保护**一个短的稳定头部，被动缓存**没有这个保护** —— 前面任何一处变动，后面全部落空，无法用断点隔离。这让「稳定」从优化变成硬约束。

**## Resolution**

**资格线（D9）：前缀区（tools + system）只收「输入来源构造上会话内恒定」的内容——「实测没变」不算数，代码上不可能变才算数。** 执法两条断言：声明↔产物一致性（`IKNOW_ASSEMBLY_ORDER` 每段必现于装配产物或显式条件段）+ 相邻两轮 tools + system deep-equal。按线盘点后 system 侧两处不合格，各得去处：`memory_layer` catalog → 会话级快照（**D8 / ADR-0042**）；`<mcp_tools_overview>` → 撤出 system。

**MCP 全链 + 溢出治理（D10 / ADR-0043）**：MCP schema 一律不 upfront（名字目录进 system、定义经 `tool_search` 按需）；开局等待 30s 首轮定稿；手动重连只消息追加；断开不动历史；溢出阈值 = 端点窗口 10%（countTokens 实测 + 配置读，仅首轮判定），退场次序与永不退场核心件名单定死（ADR-0043 §3）。内建低频件的 defer 具体名单属数据问题，由实施票按调用频次定——机制（标记位 + 阈值规则）本票定死。

**盘问过程要点**（详见 session 记录）：operator 依次裁掉「连接即全量」（上下文面积不可接受）→ 定「开局等待 + 名字目录」主形态 → 澄清溢出治理作用在首轮装配而非会话中 → 裁定手动重连走路 1（消息追加）而非本会话缺席 → 阈值判定两数（池与线）均须实测/配置，禁止口算。

### G2 · 六段 LOCKED 顺序是否重排

- type: `grilling` · state: **`closed`（2026-09-04，spec 层两票关闭，见 Resolution）** · blocked-by: —
- **次要**（D3：整个 system 侧只占前缀 6%）。

**## Question**

IKNOW-196 锁死的六段顺序（`user_profile` / `bootstrap` / `memory_layer` 夹在静态段与 `## Project path` 之间）要不要按易变度重排？重排即推翻一条明写「顺序 LOCKED，不得重排」的 spec 契约 —— **需要新 ADR**。若不重排，是否用 G3 的「搬出 system」绕过？两条路的取舍是本票的实质。

**## Resolution**

**不重排，六段 LOCKED 契约原样保留**（spec `model-prefix-layering.md` Boundaries #10 / G2 裁决落地）。D8（memory_layer 快照化，ADR-0042）+ D10（`<mcp_tools_overview>` 撤出，ADR-0043）之后，六段全部满足 D9 资格线，重排的收益基础消失 —— 剩余的易变段全部有了去处，顺序不再承载任何易变输入。关闭形式 = spec 层裁决（不需要新 ADR，因为没有推翻任何既有 ADR）。

### G3 · 易变段的去处

- type: `grilling` · state: **`closed`（2026-09-04，spec 层两票关闭，见 Resolution）** · blocked-by: —
- **次要**（同 G2：6% 的池子）。**2026-09-04 收窄（D7）**：`orchestration` 段的去向已由 ADR-0041 定案（撤出 system、并入 graph 切换提示），本票不再议它。

**## Question**

`memory_layer` / `<mcp_tools_overview>` 这两个每回合现读的段：留在 system 里，还是**整体搬出 system、改成 `messages` 尾部追加**？后者复用 ADR-0028 为状态栏选「追加不替换」的同一条论证（尾部追加不动前缀）—— 可能是本图杠杆最大的一条。代价：段从 system 降级为消息后，会被 compact 裁掉（与 G5 耦合）。

**## Resolution**

**无剩余搬家工作，两票（与 G2 一并）在 spec 层关闭**（spec `model-prefix-layering.md` Boundaries #10）。原问题里两个段各得去处且都**不是**搬 messages 尾部：`memory_layer` catalog → 会话级快照（D8 / ADR-0042，留在 system 但输入来源构造上会话内恒定，过资格线）；`<mcp_tools_overview>` → 整体撤出 system（D10 / ADR-0043，信息由名字目录 + tool_search 结果消息承载）。D7 已先撤走 `orchestration`。至此 system 侧不存在待搬家段，本票的问题空间为空。

### G4 · tools 数组是否恒定化

- type: `grilling` · state: **`closed`（2026-09-04）** · blocked-by: — （R5 已闭）· 决议进 D7
- **本图主干**（D3 + D5）。裁决：修订 ADR-0030 表达方式，产出 **ADR-0041**。

**## Question**

若 R5 证实 tools 会话内会变：graph 模式开关是否改为「工具常驻、可见性用别的手段表达」（prompt 文字 / handler 层 EXIT —— 后者 ADR-0030 已有「注册 ≠ 可见，handler 亦二次 EXIT」的先例）？这会修订 ADR-0030 的表达方式而非它的产品语义。worktree 那条路径（R5b）若也成立，本票只记录结论并把动作留给对方 session。

**## Resolution**

**裁决 = A1（operator 2026-09-04 盘问两轮定案）：`run_graph` 常驻注册 + handler 层 gate；模式切换的表达改为 `messages` 末尾追加一条更换提示；编排段（`orchestration`）整体撤出 system、内容并入切换提示。** 已落盘为 **ADR-0041**（含被否的 B/C/A2 与证据指针）；CONTEXT.md `graph mode` / `run_graph` 词条同步对齐。Grilling 关键点：

1. operator 提出的形态比 Recommend 的「description 静态文字」更好：切换提示是动态的、跟着实际状态走，且追加在尾部对前缀零影响。
2. **编排段是本票必须 coupled 处理的另一半**——tools 恒定后翻图仍会因 system 侧编排段变化带走整条 messages 缓存；A1 把它并入切换提示，system 侧从此无随模式变化的段。代价：编排指引从常驻降为切换时一次出现（遗忘风险留实施票补）。
3. 顺手立下 G1 的 tools 侧纪律形式：**会话内可变闸门只许落位 messages 尾部或 handler 层；条件装配只许以会话级常量为闸门**——「相邻两轮 tools deep-equal」即可执行断言。
4. worktree 路径（R5-D）已排除，本票无需对方 session 协调，无动作移交。

### G5 · 压缩与前缀缓存的固有冲突怎么权衡

- type: `grilling` · state: **`closed`（2026-09-04，spec 层裁决，见 Resolution）** · blocked-by: —
- D4 改写了本票：服务端 compaction 在目标端点不可用，客户端 compact **必须保留**，所以问题从「让位给谁」变成「这笔账怎么算」。

**## Question**

压缩要省上下文就**必须**丢掉早期消息，而丢掉早期消息就**必然**改写前缀 —— 被动缓存下这等于全部落空，且没有断点可以隔离。两者不可兼得。那么：压缩策略要不要为缓存让步（更晚触发、一次压得更狠、把压缩点对齐到某个自然边界），还是承认「压缩那一跳的缓存必然作废」并只优化它的频率？牵动 ADR-0013（reactive compact）。判据来自 R4 的实测频率 + G1 定下的前缀边界。

**## Resolution**

**承认 compact 那一跳缓存必废，不为此推迟/加重压缩；ADR-0013 不动**（spec `model-prefix-layering.md` Boundaries #11 / G5 裁决落地）。压缩是上下文生存问题、缓存是成本问题，前者优先级恒高，用缓存收益反证压缩让步是本末倒置。唯一约束 = compact 后的重装配同样过断言②（相邻两轮 `tools` + `system` deep-equal）—— 即缓存作废只许发生在 messages 侧的一次性改写，不许把 tools/system 拉回易变态。该约束已由 B7 断言②矩阵的 compact 场景钉死（`tests/harness/prefix-stability/`，deep-equal 总装 SC2）。

### ~~G6 · clear_tool_uses 是否接入~~

- type: `grilling` · state: **`closed`（判 out of scope）**（2026-09-03）

**## Resolution**

服务端 `clear_tool_uses_20250919` / `clear_thinking_20251015` 是 Anthropic 官方 API 的 beta 能力；目标端点（MiniMax / 火山）无支持证据（D4）。本票移出范围，条目留在 `## Out of scope`；若将来接官方端点再由新图重开。

### ~~G7 · 缓存 TTL 选 5 分钟还是 1 小时~~

- type: `grilling` · state: **`closed`（判 moot）**（2026-09-03）

**## Resolution**

被动缓存的过期由供应商管理（MiniMax 明写「根据系统负载自动调整」），调用方无 TTL 旋钮。本票无决策空间。唯一残留的关注点 —— 长任务里跨人类思考间隔会不会掉缓存 —— 是可观测事实而非决策，并入 R4 的采样口径。

### T1 · git 块内容定稿

- type: `task` · state: `blocked` · blocked-by: G1, G2, G3

**## Question**

块里放什么、放在分层结构的哪一层。charting 期的倾向（未定稿）：**当前分支** / **主分支**（注明「开 PR 时以它为基线」）/ **status** / **最近若干条 commit**；**diff 明确不放** —— 冻结的 diff 过期最快（模型自己改一行它就错了）、面积也最大，而模型随时能自己 `git diff`。选这四样的理由：分支与主分支是近乎不过期的静态事实，缺了模型会猜错 PR 基线；最近 commit 顺带给出「项目最近在做什么」和「这个仓库的 commit message 风格」，对让它写出像样的提交信息帮助直接。待定：最近 commit 取几条（多了占面积、少了看不出风格）；status 全文要不要设上限 + 截断标记（`truncateByCodepoints` 可复用；理由是脏了几百个文件的仓库会把这个块撑爆，但上限会让块在最需要它的时候恰好被截断，取舍要在票里写明）。必须包含 D1 的「开局快照、不会更新」免责句。

### T2 · git 块给不给 worker / subagent

- type: `task` · state: `blocked` · blocked-by: T1

**## Question**

worker / subagent 跑在独立进程与独立上下文里（现在连 todo 都不注入）。它们要不要 git 块？若要，是父代理的快照还是自己读一次？与 `withRoleExtras` 的段顺序契约（base < persona < constraints < addendum）怎么对齐？

### T3 · git 块的退化态

- type: `task` · state: `blocked` · blocked-by: T1

**## Question**

非 git 仓库 / git 不可用 / cwd 不可解析时块怎么退化。基本白送：`env-snapshot.ts` 的 `EnvDegradeReason` 三态分型（`cwd_unavailable` / `not_a_git_repo` / `git_unavailable`）直接复用；本票只需定「退化时段整体缺席，还是渲染显式占位」—— 注意段缺席 = 字节变化，与 KV 稳定契约的关系要跟 G1 的断点位置对齐。

## Not yet specified

<!-- in-scope 但还不够锐利，随 frontier 推进毕业成票 -->

- **六段具体怎么排**：G2 只问「要不要重排」，具体排法要等 R3 / R4 的数字，否则不知道哪些段值得动、动了收益多少。
- **auto-memory 写入时机与缓存边界的对齐**：~~记忆一写 `memory_layer` 就变、缓存就废~~ **已消解（2026-09-04，D8 / ADR-0042）**：catalog 快照化后写入时机不再影响缓存，节流问题不存在了。
- **`agent_status` 栏的累加面积是否需要治理**：每回合追加一条，长任务里总面积多大？R2 会顺带答一部分；治不治是后话。
- **多 provider 下这套分层还成不成立**：`IKNOW_LLM_BASE_URL` 允许换端点，而缓存断点语义是 Anthropic 特有的。若将来接非 Anthropic provider，分层结构要不要保留、断点怎么退化？依赖 R1 的结论。
- **「新段落地位置」的常驻纪律**：分层完成后应该产出一条可查的规则（新段按易变度落在哪一层），否则下一个加段的人还是靠个人判断。这是本图的自然产物，但形态（ADR？CONTEXT 词条？装配层注释？）等结构定了才知道。**部分已落（2026-09-04，ADR-0041 §4）**：会话内可变闸门只许落位 messages 尾部或 handler 层、条件装配只许以会话级常量为闸门——但这只覆盖 tools / 模式切换侧；system 六段侧的新段落位规则仍待 G1 收口。
- **tools 面积本身要不要治理**（D3 新掀开的雾）：**机制部分已定（2026-09-04，D10 / ADR-0043 §3）**——溢出治理规则、阈值（端点窗口 10%）、退场次序、永不退场核心件均已定死，待实施。**剩余部分**：当前形态下治理不触发与否取决于实测（countTokens 未跑、端点窗口未确认）；「谁标记 deferrable」的具体名单是数据问题，等一份「各工具实际调用频次」（在 trace 里）才能定——那是实施票的输入，不是决策。

## Out of scope

<!-- 已判在 destination 之外；关闭，不再毕业 -->

- **worktree 工具本身的形态优化** —— 并行 session 在做（Notes）。R5 只观察不改。
- **`env-snapshot` 人读面的任何改动** —— 人读面（`EnvironmentPane` / PR #666）已完成且工作正常，本图不动它。本图新增的是模型面的**另一个**投放点，两面不共用流与槽位（这正是 DESIGN-ENVIRONMENT-PRESENT 的论据真正支持的结论）。
- **模型侧 git 感知之外的其他 git 能力** —— 另图：git 工作流闭环（worktree 落地 / commit / PR / 危险动作按可逆性分级 / `/diff` `/commit`）、文件级 checkpoint 与回滚（现有 `/rewind` 只截断会话 JSONL、不回滚工作区文件；两条候选实现路径 —— 独立影子仓做提交与硬重置，或按写工具的改动做文件级全文快照 —— 留给另图取舍）。不在本 destination 内。
- **hook 系统从 v0 no-op 补全** —— `specs/126-hook-system.md` 已有 spec、`permission/hooks.ts` 只有空实现；是独立能力，与前缀分层无关。
- **服务端 context management（`clear_tool_uses_20250919` / `clear_thinking_20251015` / `compact_20260112`）** —— Anthropic 官方 API 的 beta 能力，目标端点（MiniMax / 火山方舟 Coding Plan）无支持证据（D4）。原 G6 据此关闭。若将来接官方端点，由新图重开。
- **显式 `cache_control` 断点** —— 目标端点走被动缓存，不需要（D4）。MiniMax 同时支持显式模式，但它首次写入要加价、被动模式写入免费，在本图的使用形态（长会话、前缀反复复用）下没有理由改用显式。
- **引入外部 agent 框架替换现有内核** —— 通用框架的 loop 抽象比 iknow 现有 loop-engine 薄（7 类 StopReason / 波次并发 / reactive compact / 中断 transcript 都在自家内核里），替换是降级；且 git 感知本就落在这类抽象之下，属 harness 自己的活，换框架换不来。三件确实值得单独立项的（多 provider 抽象、流式 UI 原语、工具审批形态）各属别的图。
