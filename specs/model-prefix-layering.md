# Spec: model-prefix-layering — 模型面前缀分层与缓存兑现

> 来源：wayfinder 图「模型面前缀分层与缓存兑现」（`docs/wayfinder/model-prefix-layering-map.md`，决策 D1~D10 已全部收口）。本 spec 为该图全部剩余工作的可建契约；实施按 `plans/model-prefix-layering.md`。

## Objective

让 iknow 的模型面请求前缀（`tools` → `system` → `messages`）在会话内字节稳定，从而命中目标端点（MiniMax / 火山方舟 Anthropic 兼容端点）的被动前缀缓存。用户是 iknow harness 的操作者与长会话使用者；成功 = 正常会话内前缀区零字节变化，全部会话级抖动事件（graph 翻图、MCP 连接、记忆落盘、MCP 概览刷新）被消除或转移到消息尾部，外加模型侧 git 感知（git 块）作为第一个按分层纪律落位的新住户。

## Boundaries

- **Does:**
  1. **T0 usage 段修复**：`resolveSegment` 补 `case "usage"` + import；ask 表面同样注入（607 tok 对 oneshot 可接受，IKNOW-196 SC1 原意）；重跑 `scripts/wayfinder-measure-prefix.ts` 更新 D3 数字。
  2. **执法断言 ×2**：① `IKNOW_ASSEMBLY_ORDER` 声明↔产物一致性——每个声明段必须出现在装配产物，或显式声明为条件段并给出缺席条件（条件段清单：`bootstrap` / `orchestration`-撤除后残留 / git 块 / MCP 名字目录）；② 相邻两轮装配 `tools` + `system` deep-equal。
  3. **工具面披露分层（ADR-0043）**：内建核心件（bash / read_file / edit_file / write_file / grep / glob / spawn_subagent）全量常驻永不延迟；MCP 工具 schema 一律不 upfront——名字目录进 system（首轮定稿、会话内恒定），完整定义经 `tool_search` 按需加载（结果消息追加 + schema 尾部追加进 tools 双写，此后常驻）；未加载即调用 → 复用 `ToolExecutionError`（与 run_graph 关图 EXIT 同形态），message 模板钉死「`tool <name> not loaded — call tool_search first`」；lazy 尾部追加纪律收编为通用规则。
  4. **开局等待**：首轮请求前等 MCP 连接——首轮**阻塞至 30s 超时**，超时者停止自动重试、本会话缺席（**不进名字目录**、装配照常发首轮）；窗口内连上的零破坏进首轮。手动重连成功 = 只往 messages 尾部追加一条通知（role=`user`、一行静态文本，与 ADR-0028 状态栏追加缝同形态；内容含 server 名与工具名字）；断开 = 调用报错（同 3 的 typed-error）、tools 与历史一字不动。跨模块 seam 钉死：`manager.start(opts: { firstTurnReadyTimeoutMs?: number }): Promise<void>`（build-engine 装配期 wire 给首轮请求前的 await 闸）+ `manager.onManualReconnect(cb: (serverName: string, toolNames: string[]) => void)`（wire 给 loop-engine 消息追加入口）。
  5. **溢出治理**：可延迟工具（MCP 名单 + 标记 deferrable 的内建低频件）schema 总量（countTokens 实测，禁止 chars/4 估算参与判定）超过端点模型 context window 的 10%（配置读）时，溢出部分退名字目录；仅首轮装配判定一次；退场次序 = trace 读侧三件 → web_search / web_fetch → 其余低频件按实测面积；核心件永不退场。deferrable 名单按调用频次数据定（trace 里）。**countTokens 调用失败 → 溢出治理本会话跳过**（仅名字目录常驻部分进 tools），首轮不抛错、不重试，`console.warn` 一行记录。
  6. **`<mcp_tools_overview>` 撤出 system**：其信息由名字目录 + tool_search 结果消息承载。
  7. **memory_layer catalog 会话级快照（ADR-0042）**：catalog + promote 段在会话首次装配取一次快照、会话内冻结（语义从 mtime 缓存改为快照）；bodies / prefetch 通道不动（ADR-0034 D2）。
  8. **graph 模式表达（ADR-0041）**：`run_graph` 常驻注册 + handler 层 gate（graph 关时 EXIT 拒绝）+ description 一句静态文字；模式切换 = messages 尾部追加更换提示（开图提示含编排指引，关图追加关闭提示）；`orchestration` 段撤出 system。ADR-0030 产品语义不变。
  9. **git 块（T1~T3）**：内容 = 当前分支 / 主分支（注明 PR 基线）/ status（截断上限 + 截断标记，复用 `truncateByCodepoints`）/ 最近 5 条 commit + D1 免责句（「开局快照，会话期间不更新」）；位置按分层纪律落位（会话级常量层，与 `## Project path` 同层）；**数据源 = 新模块 `src/harness/identity/git-snapshot.ts`**（git 读取隔离在该模块，`assemble.ts` 经注入缝消费——禁止 `assemble.ts` 直接 shell 出 git，守住其 fs/path-only 纯度）；worker / subagent 给父代理快照，与 `withRoleExtras` 段序契约（base < persona < constraints < addendum）对齐；退化态（非 git 仓库 / git 不可用 / cwd 不可解析，复用 `EnvDegradeReason` 三态）= 段整体缺席——接受缺席即字节变化（首个请求前已定稿，不破契约）。
  10. **G2 裁决落地**：六段顺序**不重排**（D8 后六段全部合规，IKNOW-196 LOCKED 契约不动）；G3 无剩余搬家工作（已被 D7/D8/D10 覆盖），两票在 spec 层关闭。
  11. **G5 裁决落地**：承认 compact 那一跳缓存必废，不为此推迟/加重压缩（ADR-0013 不动）；唯一约束 = compact 后的重装配同样过两条断言。
- **Confirms with human:** deferrable 内建名单的具体成员（属数据问题，实施时按调用频次定，超出 ADR-0043 §3 预置次序时回报确认）。
- **Out of this spec:** R6（两端点被动缓存实测收益校准，需凭证，单独票）；`cache_control` / 显式断点 / 服务端 context management（D4 判出）；worktree 工具形态（并行 session）；`env-snapshot` 人读面；git 工作流闭环与文件级 checkpoint（另图）；hook 系统补全；ToolSearch 的服务端 `tool_reference` 机制（目标端点不支持，客户端双写替代）。

## Success Criteria

1. harness 测试：装配产物包含 `IKNOW_ASSEMBLY_ORDER` 全部声明段（或显式条件段按缺席条件缺席）——断言 ① 红/绿二元。
2. harness 测试：同一会话相邻两轮装配（含 MCP 连上前后、graph 翻图前后、记忆落盘前后、compact 前后的重装配）`tools` + `system` deep-equal——断言 ② 红/绿二元。
3. 测试：MCP 工具 schema 不出现在首轮 `tools` 数组；system 含名字目录；调 `tool_search` 后 schema 尾部追加进 tools 且 result 消息存在。
4. 测试：MCP 未连上时首轮装配阻塞至超时（fake timer ≤30s）；超时 server 不出现在目录；手动重连成功后 messages 尾部追加一条通知、tools/system 字节不变。
5. 测试：graph 关→开→关，`tools` 与 `system` 逐字节不变；graph 关时调用 `run_graph` 被 handler EXIT 拒绝；开图后可调用；messages 尾部出现切换提示。
6. 测试：会话内记忆文件落盘后，装配产物中 catalog 段与首次装配 deep-equal。
7. 测试：溢出治理——注入超阈值工具面时首轮装配将预定次序的工具退到名字目录；未超阈值时不退；会话中不重算。
8. 测试：git 块四要素 + 免责句渲染于装配产物；非 git 仓库时段整体缺席且装配不报错。
9. `npm test` 全绿；改动触及 LLM 客户端 / adapter / loop 契约 → `npm run test:real-llm` 补真实模型 e2e（缺 key 显式 Not run）；沙箱/中断边界无涉则不跑 probe。
10. 重跑 `scripts/wayfinder-measure-prefix.ts`，输出中 usage 段在场、D3 数字更新。

## Open Questions

(none) —— 假设门 11 条已于 2026-09-04 由 operator 全部确认；唯一开放项（deferrable 具体名单）为数据问题，归入 Boundaries 的 Confirms with human。

## Inherits / Changes

- **Inherits**（决策与既有契约，实施必须引用不得重开）：
  - ADR-0041（graph 表达）/ ADR-0042（catalog 快照）/ ADR-0043（披露分层）——本 spec 的直接依据。
  - ADR-0030（graph 产品语义）/ ADR-0013（reactive compact）/ ADR-0028（状态栏追加）/ ADR-0037 §4（`projectIdentityRoot` 稳定根）/ ADR-0009/0031/0034（memory 通道与信任）。
  - IKNOW-196 六段顺序 LOCKED（`specs/196-identity-assembly.md`）——不重排。
  - 前缀资格线（D9）：前缀区只收「构造上会话内恒定」的内容；可变闸门只许落位 messages 尾部或 handler 层（D7）。
  - 前缀序 `tools → system → messages`、被动缓存语义、无断点（D4）。
  - 既有机制：`createSystemResolver`（`memory/refresh.ts`）、lazy/tool_search 通道（#631/#224）、`EnvDegradeReason`、`truncateByCodepoints`、`visibleSchemas()` 组合序。
- **Changes**：`<mcp_tools_overview>` 与 `orchestration` 两个 system 段退场；`memory_layer` catalog 从「mtime 缓存」改「会话快照」；MCP 工具从「连上即全量 schema」改「目录化 + 按需加载」；`run_graph` 从「条件装配」改「常驻 + gate」；`resolveSegment` 补 usage case。**新增模块 `src/harness/identity/git-snapshot.ts`**（git 读取唯一出口，退化态三态分型）；**新增跨模块 seam**：`manager.start({firstTurnReadyTimeoutMs})` / `manager.onManualReconnect(cb)`（mcp 侧）→ `awaitFirstTurnReady()` / `onReconnectNotification(text)`（loop-engine 消费面），由 build-engine 装配期 wire。CONTEXT.md 领域词随 persist 更新（前缀资格线 / 名字目录 / 开局等待 / 溢出治理 / 会话级快照段 / git 块，渐进式披露修订）。

## architecture-change-reviewer

**第一轮（2026-09-04，原稿）— BLOCKED（2 unclear）**：bounded-context-guardian unclear（git 块数据源未命名、mcp↔engine seam 未定义）；error-handling-enforcer unclear（typed-error 未钉、countTokens 失败路径、通知消息 schema、MCP 超时语义二选一未定）；其余 3 项 yes。按 6 条修正建议修 spec：钉 git-snapshot.ts 模块、两条 manager seam、ToolExecutionError + 提示模板、countTokens 失败跳过、超时=缺席不进目录、通知消息 role=user 一行静态。

**第二轮（2026-09-04，修订稿复审）— PASS（5/5 yes），hand to writing-plans**：

```
bounded-context-guardian: yes — git 数据源收敛到新模块 identity/git-snapshot.ts（assemble.ts 经 grep 确认零 shell git、仅沙箱策略注释），mcp↔engine 协同钉为 start({firstTurnReadyTimeoutMs}) + onManualReconnect(cb) 两条 manager seam（build-engine 装配期 wire，无反向依赖），git 块走加性段与 ## Project path 同形态
defensive-contract-validator: yes — SC1-SC10 覆盖 empty（SC4/SC8 缺席不报错）/ negative（EnvDegradeReason 三态沿用 cwd_unavailable|not_a_git_repo|git_unavailable）/ overflow（SC7 countTokens 实测 + 10% 阈值 + 退场次序 + 失败跳过）/ concurrent（SC2 相邻轮 deep-equal 四场景）/ exception（SC5 run_graph 关图 handler EXIT 拒绝、SC3 ToolExecutionError 模板钉死）
error-handling-enforcer: yes — 全部失败路径 typed 且非空：未加载即调用=ToolExecutionError + 钉死模板、countTokens 失败=跳过+warn、MCP 超时=阻塞至 30s→缺席不进目录+装配照常、MCP 断开=typed-error+tools/history 不动、手动重连=只消息追加、非 git 仓库=段缺席不报错，message schema role=user 一行静态已钉
complexity-anti-drift: yes — 各模块增量改动无 god-function：git-snapshot.ts 单职责、manager 两方法不加新抽象类、resolveSegment 仅补 case "usage"、加性段沿用 ## Project path 既有先例（assemble.ts:395-401），IKNOW_ASSEMBLY_ORDER 6 段 LOCKED 不动
minimal-change-verifier: yes — 单一逻辑任务（模型面前缀字节稳定 + git 块作为分层纪律首住户），收敛到 ADR-0041/0042/0043 三票决策；Out of scope 显式排除 R6/cache_control/worktree 形态/git 工作流闭环/env-snapshot 人读面/hook 系统/服务端 tool_reference
```
