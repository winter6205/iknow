# Spec: 会话文件夹归并与 trace 正文内容寻址

> 承接本轮 logicsync 讨论(议题起于 `specs/mutate-write-contract.md` 范围外的 #946 方向 5)。本 spec 只做**记录面**:会话状态从五个锚点归并成一个会话文件夹,并把 trace 的 O(n²) 正文重复收成内容寻址池。**不做能力面**(子代理 `backgroundManager` / 后台登记表所有权 / 网络),那三条另立 spec,见「后续」。

## Glossary(exact copy from docs/CONTEXT.md)

- **projectIdentityRoot**: 用户此刻在做的那个项目的身份根,宿主启动时钉一次、跨 session worktree rebind 不变——**项目身份只问它**:rules / 项目 `AGENTS.md` / `permissions.toml` / 项目 skills 发现 / 子代理继承的身份根 / 记忆库命名空间名。与 `productRoot` 分开是因为宿主按 ADR-0019 从 `workspaceRoot` 取 `productRoot`,而 `--workspace-root <dir>` 重定向档下 `dir ≠ cwd`;取值由装配层决定(宿主钉的值优先,缺席时 `mainCheckoutOf(cwd)`),校验在 SessionRoots。
- **SessionRoots**: 会话四角色根 SSOT(`src/harness/session-roots.ts`)——`productRoot` / `projectIdentityRoot` / `taskRoot` / `installRoot` 一次按角色归位,消费者只消费返回值,不再自行拼 `join(cwd, '.iknow', …)`、读 `process.cwd()` 或自行判断 task worktree。`resolveSessionRoots` 是纯函数:不读 git、不碰文件系统、不持会话状态,缺根 / 空白 / 相对 / 不可规范化一律 typed fail-closed(`SessionRootError`),**绝不**回退 `process.cwd()`。
- **task worktree label**: 给人/模型认树的 kebab 目录名。有合法 label 时叶子就是 `<slug>`,conversationId 不进文件夹(写在 gitdir sidecar;历史 `<slug>--<conversationId>` 仍可反演)。非法或缺席则叶子仍是纯 conversationId。同名已存在 → 建树失败不覆盖。
  _Avoid_: 把 label 当 conversationId;**用 session `title` / `goal` 当 slug**;把 uuid 写进文件夹名当展示面

(完整句以 `docs/CONTEXT.md` 为准,本 spec 不重定义。第三条 _Avoid_ 约束的是 **worktree label**,不约束本 spec 的会话文件夹名 —— 会话文件夹用 conversationId 正是为了不引入第二套命名规则,展示面由上一层项目 slug 与记录内 `title` 字段承担。)

## Architectural Constraints

- **ADR-0036「所见即所填」**:trace 的 `messages` 捕获的必须是模型实际看到的完整消息集,**不得截断**。这是 ADR-0036 当年否决 delta/off 写侧模式的理由,本 spec 继承。
  > **误引修正(本轮实测发现)**:ADR-0036 正文把这个不变量溯源为「ADR-0014 验收纪律的刻意决策」,但 `docs/adr/0014-subagent-foreground-spawn-default.md` 实为「Subagent spawn 语义:前景同步为默认契约」,全文不含「所见即所填」;该短语全仓**只出现在 ADR-0036 自己正文里**。ADR-0014 `:46` 只是把 trace 当验收 ground truth(`messages_captured` 断言模型实际看到的 system prompt),不等于拥有该不变量。故本 spec 的溯源一律指向 **ADR-0036**,并在 ADR-0036 的 amend 中修正这条误引。
- **ADR-0036**:blob 引用模式已实现且测试覆盖(写侧 `trace/jsonl.ts:105-125`、读侧 `traceserver/project-tool-results.ts:136-170`),但 opt-in 且默认 `full`,九天从未启用(`blobs/` 目录在盘上不存在)。本 spec 把它改为唯一模式并**修订其去重粒度**。
- **ADR-0035**:trace 是崩溃取证的无条件面,不得因体积治理而降级为可选。**本 spec 不削弱它** —— persist 阶段实测:ADR-0035 管的是**生命周期面**(`subagent_spawn` / `subagent_state_change` / `subagent_stop` + stderr 指针),这些记录**不含 messages 正文**,`toBlobReferences` 对它们从不触发,故 `blobs/` 可写前置碰不到它。前置实际落在 **content 面**(ADR-0003 D10 scope 的 `llm_call.messages`)。后果:两面敏感度分化 —— 同一次事故可能生命周期行齐全而 `llm_call` 缺席,取证须知「`llm_call` 缺席 ≠ 那次调用没发生」。已记入 ADR-0035 与 ADR-0003 的同日 Amendment。
- **ADR-0003**:两面都要守。
  - **D13 / D14 原样继承,不 amend**:`TraceService.recordXxx` **MUST NOT throw**(接口 `@throws never`,经 `src/harness/trace/safe-trace.ts` 的 `safeTrace` 集中;loop-engine 埋点只 `await safeTrace(...)`,从不直调 `recordXxx`);`recordLlmCall` 返回 `undefined` 时 `recordToolCall` **仍被调用**,落 `parent_llm_call_id: null`(部分树优于静默丢子树)。
  - **greppability 收窄**:事件行、`tool_call` 参数、`status`、`error` 必须仍可 grep;本 spec 只在 **messages 正文**维度让位给内容寻址。
- **ADR-0027**:session jsonl 是耐久会话记录(可续跑 / 可 rewind 的链表:`message` 节点带 `id` + `parent`,`head` 记录指向链尾)。本 spec 只改它的**位置**,不改其记录形状 —— 正文加入共享 blob 池属 Phase 2,显式排除。
- **ADR-0021 D1.3**:后台任务登记表是 per-root 活状态,锚在 `stateAnchor`。**本 spec 不动它** —— 按「记录 vs 带锁活状态」的二分,它不属于会话文件夹。
- **ADR-0037 §4**:改绑后 `bash_output` / `bash_stop` 仍看得见改绑前起的任务,树上不另开一份登记。同上,不动。
- **ADR-0040**:子代理是父会话执行臂,继承父写根,不另开产物目录。本 spec 的 `subagents/` 是 **harness 记录面**,不是子代理的产物目录,与该 ADR 不冲突。
- **`docs/CONTEXT.md` SessionRoots 词条**:消费者不得自行拼 `.iknow` 路径、不得读 `process.cwd()`。本 spec 新增的会话文件夹解析必须是纯函数,键取自 SessionRoots。

## Objective

**What:** 把同一个会话散在**五个锚点**的记录面归并进一个会话文件夹,并把 trace 里 O(n²) 的累计消息重复收成 content 级内容寻址池,使「原文只存一份」在 trace 内部成立。

```
~/.iknow/projects/<项目 slug>/<conversationId>/
    <conversationId>.jsonl + .json    会话记录(ADR-0027,链表 + head)
    todos.md                          todo ledger
    trace.jsonl                       执行观测(llm_call / tool_call / turn / …)
    blobs/<sha256>                    messages[].content 正文,mask 后写入,唯一一份
    subagents/agent-<id>.jsonl        子代理 trace(取代 conversationId="subagent" 聚合)
    subagents/agent-<id>.meta.json
    tool-results/                     目录契约在本 spec;写入实现见「后续」
```

**Why:** 五处实测/代码可证的缺陷,同一根因——**记录面没有「会话」这个单位**:

1. **分组键名不副实**:`resolveProjectSessionDir`(`session-store.ts:100-110`)注释自称 "Project namespace",实际键是 `basename(cwd)`。而 iknow 的 cwd 随 worktree 改绑移动,于是**同一项目的会话被劈成 N 个平级文件夹**。盘上实测:`~/.iknow/sessions/` 下 127 个目录里 `126-hook-system-3d7759ffa337`、`128-verify-loop-86751ccd061c`、`321-tui-opentui-migration-9d0906d38c93`、`653-hygiene-7dbf90da9ee6`、`820-75d95286e7ef` 全是同一个项目(iknow)的不同 worktree。
2. **子代理平铺,父子关系在文件系统上丢失**:127 个目录里 **7 个是 `agent-*`**(`agent-general-purpose-47d02c57-…`、`agent-a81be157cd76ab545-…`),与项目目录**平级**。参考形状是嵌在父会话内(`subagents/agent-<id>.jsonl` + `.meta.json`,meta = `{agentType, description, toolUseId, spawnDepth}`)。平铺的后果:`listSessions` 把子代理当同级会话列出,lineage 只能靠 trace 反推。
3. **trace 锚点 cwd 相对,337MB 挂在仓库根**:`DEFAULT_TRACE_DIR = "./trace/"`(`cli.ts:77`)→ 从哪个目录启动就落哪。实测 `~/projects/iknow/trace/` = **337MB / 82 个 jsonl**(已 gitignore,`.gitignore:95` root-anchored)。同一 conversationId 的 session 记录在 `~/.iknow/sessions/`,trace 在 `./trace/`,**同一个键落在两个不同锚点**。
4. **trace 的 O(n²) 双写从未被治**:ADR-0036 实测「trace/ 263.5MB 中 **98.2%(226.5MB)是 llm_call 行内全量累计消息历史的逐字节重复**(单行最大 891KB)」,方案已实现已测试,但 **opt-in 默认关,`blobs/` 至今不存在**。同一 conversationId 实测:trace 41 行 / 264K,session 88 行 / 72K —— **行数一半,体积 3.7 倍**,因为第 N 个 `llm_call` 行内联前 N-1 轮全部消息。全库 trace 337M vs session 12M。
5. **ADR-0036 的去重粒度选错,且漏记了一个代价**:它把**整条 message** 换成 `{sha,bytes}`,`role` 一并丢失。而读侧 `query_trace` 直接吃原始 row(`query-trace-core.ts:225-244`):`messageRole()`(`project-tool-results.ts:48-51`)对 `{sha,bytes}` 返回 undefined → **`last_assistant_preview` 静默消失**,而 `:235-238` 注释明写「字段缺席 = 合法态(无 assistant 消息)」→ **故障与合法空态无法区分**;`first/last_message_preview` 渲染成 `{"sha":…}` 死预览。ADR-0036 只记了「不可 grep 正文」这一个代价,**漏记了这条**。而 `last_assistant_preview` 正是 `:230-232` 说的「外部 agent 取最终 assistant 结论的动线」。

**Who:** CLI / TUI / serve 操作员(会话列表、`--resume`、trace 取证);外部 agent 经 iknow-trace MCP 读子代理结论;下游实施 = harness 记录面 + traceserver 读侧。

## Boundaries

- **Does:**
  - 会话文件夹布局与解析(纯函数,键 = `projectIdentityRoot` + `conversationId`)
  - session 记录 / todos / trace / blobs / 子代理 trace 五类归并
  - blob 从 opt-in → 唯一模式;去重粒度从整条 message → **content**;删故障回退(fail-closed)
  - traceserver 三工具(`list_sessions` / `query_trace` / `get_record`)寻址从平铺 → 两级树,并补 `query_trace` 的 content 解引用
  - `dist/trace-mcp` 重建与实跑验收
  - 旧 337MB trace 归档至 `~/.iknow/archive/trace-legacy/`
  - 三处过时注释重写(`todo-write.ts:425-447` 整段、`:432` 的裸引用 `chat-session.ts:963`(真身 `src/cli/chat-session.ts:2062`,行号已漂移约 1100 行)、`tui/deps.ts:266`)
- **Confirms with human:** (none) —— 20 条假设已在本 session 逐条确认或按建议通过。
- **Out of this spec:**
  - **Phase 2**:session 记录正文加入同一 blob 池(消掉残留 12M 跨文件双写)。要动 resume 链路(`specs/session-jsonl-resume.md`),风险独立,见「后续」1。
  - **`tool-results/` 的写入实现**(前台 bash 12K 截断溢出落盘)。本 spec 只钉**目录契约**;写入实现要动 `sandbox/runner.ts:17` 的截断权威,blast radius 独立,见「后续」2。
  - **子代理 `backgroundManager` 注入与后台登记表所有权**(父子共用一张 vs 各一张)。属能力面(ADR-0021),见「后续」3。
  - **worker `conversationId: "subagent"` 假 scope**(`cli.ts:295`、`tui/deps.ts:262`)。本 spec 记为**已知缺陷 L2**,因为 `subagents/agent-<id>` 的 `<id>` 来源依赖它;修法属能力面,见「后续」3。
  - **chat REPL 缺 `conversationId`**(`cli.ts:364-368`)。操作员当前只做 TUI,TUI 经 hub per-run 注入(`hub.ts:1459`)是干净的,见「后续」4。
  - **网络三件**(审计 / 批准文案 / 资格前置)。属网络轴(ADR-0022),见「后续」5。
  - **`vitest.config.ts:22` exclude glob 漏排 `_archive/**`**。与本 spec 无因果关系,独立一行修。
  - **不动**:围栏可写集(ADR-0037 §9.2 写白名单 = `taskRoot` + `/tmp`,无第三者)、后台任务登记表锚点(ADR-0021 D1.3)、worktrees 锚点、写工具路径合同(`aci/tools/helpers.ts`,另有会话在改)。

## Success Criteria

### 布局与键

- **SC1** — `resolveProjectSessionDir` 的键是 `projectIdentityRoot`,不是 `cwd`。可测:同一 `projectIdentityRoot` + 两个不同 `cwd`(主仓 / 其 task worktree)→ 返回**同一路径**;两个同名不同路径的项目 → 返回**不同路径**(sha1 后缀区分)。
- **SC2** — 会话文件夹名 = `conversationId` 原文(UUID)。断言:路径最后一段匹配 UUID 形状;**不含** worktree label、**不含** session `title` / `goal`。
- **SC3** — 项目 slug 形式保持 `<basename(root)>-<sha1(root)[:12]>`,只换输入根。断言:slug 正则不变,既有 sanitize 先例(`todo-write.ts:465-467`)复用于 conversationId 段。
- **SC4** — 解析函数是**纯函数**:不读 git、不碰文件系统、不回退 `process.cwd()`;缺根 / 空白 / 相对 / 不可规范化 → typed fail-closed(与 `resolveSessionRoots` 同形)。

### 归并成员

- **SC5** — todos 落 `<会话文件夹>/todos.md`。断言:`resolveSessionTodoDir` 在 `src/` 中不存在(grep 为空);任何路径中**不出现** `todos/chat`、`todos/serve`、`todos/tui` 字样;`<surface>` 参数从 todo 路径链上消失。
- **SC6** — trace 落 `<会话文件夹>/trace.jsonl`。断言:`DEFAULT_TRACE_DIR = "./trace/"` 退役;从仓库根与从其 task worktree 各启动一次同会话 → trace 落**同一文件**;仓库根不再新增 `trace/`。
- **SC7** — `blobs/` 是 `trace.jsonl` 的兄弟目录,且 `traceDir` 由 `dirname(traceFilePath)` 派生。断言:`project-tool-results.ts:161` 的 `options.traceDir!` **非空断言消失**;调用方不再单独传可与 `filePath` 矛盾的 traceDir。
- **SC8** — 子代理记录落 `<父会话文件夹>/subagents/agent-<id>.jsonl` + `.meta.json`。断言:归并后 `~/.iknow/projects/**/` 顶层**不存在** `agent-*` 目录;`createTrace("subagent")` 那种「全机所有子代理聚合成一个文件」的形态退役;`.meta.json` 至少含 `{agentType, toolUseId, spawnDepth}`。

### blob 唯一化

- **SC9** — 开关退役。断言:`IKNOW_TRACE_MESSAGES`、`MessageStorageMode`、`resolveMessageStorageMode` 在 `src/` 中 grep 为空。
- **SC10** — 去重粒度 = **content**。断言:blob 模式下 `messages[i]` 仍是 `{role, content}` 两键对象,`content` 为 `{sha, bytes}`;`messageRole()`(`project-tool-results.ts:48-51`)**源码未改动**,且对 blob 模式记录返回正确 role。
- **SC11** — 无故障回退,且**不违反 ADR-0003 D13**。抛错层钉死:失败发生在**内层 blob IO**,由既有 `safeTrace`(`src/harness/trace/safe-trace.ts`)/ recordFailure warn-once 路径吞掉 → `recordLlmCall` **返回 `undefined`** → 该次调用**零行落盘(含零内联回退行)** → **turn 存活,调用方看不到异常**。按 ADR-0003 **D14**,下游 `recordToolCall` 仍以 `parent_llm_call_id: null` 落盘(部分树优于静默丢子树)。断言写成**可观察结果**而非「抛错」:`blobs/` 不可写(占位为普通文件)时 —— (i) trace 文件中该 `llm_call_id` **一行都不存在**;(ii) 文件中**不存在**任何内联全量 `messages` 行;(iii) `recordLlmCall` 返回 `undefined` 而不 throw;(iv) 同轮后续 `tool_call` 记录**仍在场**且 `parent_llm_call_id` 为 `null`;(v) loop 不中断。`tests/harness/trace/jsonl.test.ts:856` 的 "falls back to the masked full row when blob storage fails" 用例被替换为上述五条断言,不是删除后无替代。
  > **语义澄清**:操作员要求的「不留故障回退」= **永不写内联全量行**(去重是唯一存储形态),**不是**「让 trace 把异常抛进调用方 turn」。后者会违反 ADR-0003 D13(`recordXxx MUST NOT throw`,接口标注 `@throws never`),本 spec 继承该契约不 amend。代价见 ADR-0035 限定条款(「待写入」)。
- **SC12** — 去重生效。断言:同一 message 在 N 个 `llm_call` 中出现 → `blobs/` 下**恰好 1 个**对应文件;`flag:"wx"` 的 EEXIST 被吞(`jsonl.ts:122-124` 既有行为保持)。
- **SC13** — mask 与完整性。断言:blob 内容**不含**原文 secret、含 mask 标记;`bytes` == blob 文件实际 UTF-8 字节数;`sha` == blob 内容的 sha256(既有 `:840-849` 断言保持)。

### 读侧(iknow-trace MCP)

- **SC14** — `query_trace` 三个 preview 在 blob 模式下返回**正文预览**,不是 `{"sha":…}`。断言:`first_message_preview` / `last_message_preview` 非空且不含 `"sha"` 字面量;**有 assistant 消息时 `last_assistant_preview` 必须在场**(这是本轮修的核心静默失效)。
- **SC15** — `query_trace` 的 `messages_count` / `tool_result_count` / `tool_result_previews` 在 blob 模式下与 full 模式的历史基线**逐字段相等**。
- **SC16** — `list_sessions` 走两级树发现会话。断言:返回的 `conversation_id` 集合与磁盘上 `<会话文件夹>` 名集合相等;`agent_version` 从该会话的 `trace.jsonl` 取得;`mtime` / `size` 语义有明确定义(以 `trace.jsonl` 为准还是以文件夹为准,二者择一并在测试中钉死)。
- **SC17** — `get_record` 两臂(`detail=messages` / `detail=tool_results`)在 blob 模式下 part 坐标、`part_chars`、role 标注与 full 模式基线一致(`get-record-core.ts:250-251` 既有解引用点改为 content 级)。
- **SC18** — `dist/trace-mcp` 重建后**实跑验收**:对同一真实会话依次调 `list_sessions` → `query_trace` → `get_record`,三者内容互相一致且 preview 为正文。仅单测全绿不算完成(`scripts/iknow-trace-mcp.cjs:6-12` spawn 的是 `dist/trace-mcp/main.js`,源码改完不重建则 MCP 看不到变化)。

### 归档与文档

- **SC19** — 仓库根 `trace/`(337MB / 82 文件)迁至 `~/.iknow/archive/trace-legacy/`。断言:迁移后仓库根**不存在** `trace/`;`~/.iknow/archive/trace-legacy/` 下文件数 == 82;**`archive/`(未被 gitignore)下无任何新增文件**;`git status` 干净。
- **SC20** — 过时注释重写(按实测,不含 phantom 项)。断言:
  - (i) `todo-write.ts:425-447` 不再声称 per-conversation 隔离「未落地 / deferred」—— 该隔离在拿得到 `ctx.conversationId` 时**已经生效**(`:143-148` 调用期解析),注释描述的「all sessions within the same surface share `<userHome>/.iknow/todos/<surface>/todos.md`」已非现状;
  - (ii) `todo-write.ts:432` 那条 `chat-session.ts:963` 引用被修正为真实位置 —— 裸文件名有歧义(真身是 `src/cli/chat-session.ts`),且**行号已漂移约 1100 行**:`conversationId = opts.resumeId ?? randomUUID()` 实测在 **2062** 行,而 963 行现在是无关的 rebind 检测代码;
  - (iii) 同段对 TUI 的判断(`tui/deps.ts:266` 配套注释)被修正 —— TUI 经 hub per-run 注入 `conversationId`(`hub.ts:1459`),**不属于** deferred 面;
  - (iv) 全仓不再存在声称「todos 按 surface 共享」的注释。

### 已知限制(钉行为,不假装解决)

- **L1** — `list_sessions` 从扫平铺目录变为走两级树,**扫描成本未实测**。归并后目录数 = 项目数 × 会话数(当前 127 个会话目录会重排)。缓解:沿用既有「只读每文件前 64 KiB」窗口。**触发重开的条件**:实测单次 `list_sessions` 超过 1s,则引入索引文件(不在本 spec)。
- **L2** — worker 的 `conversationId` 是硬编码字面量 `"subagent"`(`cli.ts:295`、`tui/deps.ts:262`),所有子代理共用一个 id。SC8 的 `agent-<id>` 里的 `<id>` 因此**不能用 conversationId**,必须用子代理自身的 spawn id(envelope 已有)。**本 spec 只保证命名不依赖那个假 scope**;真正修它属能力面,见「后续」3。
- **L3** — 不做旧存量兼容:127 个会话目录与 337MB trace 不迁移进新布局(trace 只归档)。`--resume <id>` 对旧会话**全部失效**,TUI 会话列表**清空**。这是操作员已确认的决定,不是缺陷;但必须在 CHANGELOG 与 handoff 中显式写出。

### 输入五类(S2,实施必须覆盖)

**表 A — 会话文件夹路径解析(纯函数)**

| 类         | 用例                                                                | 期望                                                                                                                            |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| empty      | `conversationId` 为 `undefined` / 空串;`projectIdentityRoot` 为空   | typed fail-closed,**绝不**回退 `process.cwd()` 或产出 `<slug>//` 这类畸形路径                                                   |
| negative   | `conversationId` 含 `/`、`..`、`.`;`projectIdentityRoot` 为相对路径 | 复用 `sanitizeConversationSegment`(`todo-write.ts:465-467`):`..` 风格与含分隔符的 id **不可能逃逸**会话文件夹;相对根 typed fail |
| overflow   | `conversationId` 超长(逼近文件系统单段 255 字节);slug 超长          | 有明确上限与 typed 拒绝,不静默截断成撞名的短 id                                                                                 |
| concurrent | 两个进程同时对同一 `conversationId` 建文件夹                        | `mkdir recursive` 幂等;不产生半建状态;不互相覆盖既有记录                                                                        |
| exception  | `mkdir` 抛 EACCES / ENOSPC / ENOTDIR                                | typed 冒泡,**不**降级到别的锚点、**不**静默改用 cwd                                                                             |

**表 B — blob 引用读写**

| 类         | 用例                                                              | 期望                                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| empty      | `content` 为空串 / 空数组 / `null`                                | 仍走内容寻址(空内容有其 sha),**不**特判成内联;读侧还原为同形空值                                                                                                                                                                                                               |
| negative   | `sha` 为空 / 含 `/`;`bytes` 为负 / 非数字 / 与实际不符            | 沿用 `project-tool-results.ts:244-246` 校验:拒绝,不当路径拼接;`bytes` 不符按损坏处理                                                                                                                                                                                           |
| overflow   | 单条 message 极大(ADR-0036 实测单行最大 891KB);单会话 blob 数极多 | 写入不因单条过大失败;`get_record` 的字符窗口分页对大 blob 仍可用(`count` / `from_char` 语义不变)                                                                                                                                                                               |
| concurrent | 两个进程同时 write-if-missing 同一 sha                            | `flag:"wx"` + EEXIST 被吞(`jsonl.ts:122-124`);**不**出现半写文件被另一方读到                                                                                                                                                                                                   |
| exception  | 读侧 blob 文件缺失 / 损坏;写侧 `blobs/` 不可写                    | **读侧**:不得抛进调用方 turn(`project-tool-results.ts:170` 既有 EXIT 保持)。**写侧**:fail-closed **于内层 blob IO**(SC11)—— 经既有 `safeTrace` / recordFailure warn-once 吞掉,`recordLlmCall` 返回 `undefined`,该次调用零行落盘,**不**回退内联、**不**向调用方抛(ADR-0003 D13) |

**表 C — content 的两种合法形状(实现必钉)**

| 类     | 用例                                                                 | 期望                                                  |
| ------ | -------------------------------------------------------------------- | ----------------------------------------------------- |
| 形状 1 | `content` 是 block 数组(盘上实测形状:`[{"type":"text","text":"…"}]`) | 整个数组被 ref 替换;读侧还原为数组                    |
| 形状 2 | `content` 是纯字符串(Anthropic 形状同样合法)                         | 字符串被 ref 替换;读侧还原为字符串,**不**被误包成数组 |
| 混合   | 同一 `messages` 数组里两种形状并存                                   | 逐元素独立判定,互不影响                               |

## Open Questions

(none) —— 20 条假设已在本 session 逐条确认或按建议通过;L1/L2/L3 是已知限制而非未决问题,均带触发重开条件或归属 spec。

## Inherits / Changes

**Inherits(本 workspace 已提供、本契约依赖的)**

- `resolveProjectSessionDir`(`session-store.ts:100-110`)—— 布局形状 `<base>/sessions/<basename>-<sha1[:12]>` 复用,只换输入根;函数自称 "Project namespace" 而键是 cwd,本 spec 让它名实相符。
- `SessionRoots.projectIdentityRoot`(`session-roots.ts`)—— 现成根角色,CONTEXT.md 明写「跨 session worktree rebind 不变」,正是分组键所需;纯函数 + typed fail-closed 的形状照抄。
- `sanitizeConversationSegment`(`todo-write.ts:465-467`)—— 路径敌意段净化器,已有「`..` 风格不可能逃逸」的保证。
- `toBlobReferences`(`trace/jsonl.ts:105-125`)—— mask → sha256 → `flag:"wx"` write-if-missing,EEXIST 吞掉。
- `dereferenceTraceMessages`(`get-record-core.ts:251`)—— 已存在的解引用点,`query_trace` 复用它,不新写第二份。
- blob 读侧安全件:sha 校验(`project-tool-results.ts:244-246`)、缺失不抛进 turn 的 EXIT(`:170`)。
- `resolveConversationTodoDir` 的**两段式**(装配期注入根 + 调用期按 `ctx.conversationId` 拼子目录,`todo-write.ts:139-148`)—— 会话文件夹的键正好也是两段(`projectIdentityRoot` 冻结 + `conversationId` 调用期),**沿用同一缝形状,不新增注入点**。
- **ADR-0046(todo replace + 同目录快照)**:快照实现 `snapshotCurrentTodos` 用 `dirname(filePath)` 拼 `todos.<unixMs>.<hex>.md`(`todo-write.ts:347-358`),路径跟着 `filePath` 走 → **归并后快照自动落进会话文件夹,快照逻辑不需改动**。而且 ADR-0046 原文「旧文件留在**同一会话目录**当快照」与工具描述「`<session>/todos.md`」(`:119`)此前只是愿望(实际是 `<surface>` 共享根,同一会话从不同入口开还会分裂),归并后成为事实。
  > **未能给 ADR-0046 落同日 Amendment**:`pre-context-write-guard` 拒写,理由是「ADR 编号 0046 已被 `0046-exact-name-load-and-index-demotion.md` 占用」。实测 `docs/adr/` 存在**两处重号** —— `0046`(exact-name-load-and-index-demotion / todo-ledger-replace-and-snapshots,均 2026-09-06)与 `0055`(phase2-back-edge-on-failure-only / user-hook-router,均 2026-09-08),判断是并发会话各自「扫最大号 +1」撞号。**这是既有缺陷,不属本 spec 范围**,改号是操作员的决定(要连带修所有引用),本 spec 不擅自处理,只把 ADR-0046 的交互记在这里。
- 测试命令:`npm test`(vitest,unit + harness + integration)。
- 参考形状(证据等级:盘上实测 `~/.claude/`;openharness 部分来自 `~/.cache/codebase-memory-mcp/…upstream-openharness.db` 索引 docstring,**低于读源码**):`projects/<slug>/<conversationId>/{tool-results/,subagents/}` + `tasks/<conversationId>/`。

**Changes**

- `resolveProjectSessionDir` 键:`basename(cwd)` → `projectIdentityRoot`;布局加一层 `<conversationId>/`。
- `resolveSessionTodoDir` 退役,`<surface>` 层消失;todoDir 根改由会话文件夹派生。
- `DEFAULT_TRACE_DIR = "./trace/"`(`cli.ts:77`)退役;trace 锚点从 cwd 相对改为会话文件夹。
- 子代理 trace:`createTrace("subagent")` 单文件聚合(`hub.ts:2869`、`cli.ts:336`)→ `subagents/agent-<id>.jsonl` per-agent。
- blob 模式:opt-in → 唯一;**去重粒度 整条 message → content**;`role` 保持内联。
- 故障回退删除(fail-closed),对应测试替换而非移除。
- traceserver 三工具寻址:平铺 `<traceDir>/<conversationId>.jsonl`(`query-trace-core.ts:86`、`get-record-core.ts:112`)→ 两级树;`query_trace` 补 content 解引用。
- `dist/trace-mcp` 重建纳入交付验收。
- ADR 面:**ADR-0071 新增**(会话文件夹归并 + 新不变量「trace 不得引用 session 记录」)、ADR-0036 amend(粒度 + 唯一模式 + 补记漏掉的代价 + **修正它对 ADR-0014 的误引**)、ADR-0035 限定条款(无条件面以 `blobs/` 可写为前置)、ADR-0003 收窄(messages 正文维度;D13/D14 继承不 amend)、ADR-0027 amend(session 记录位置)。

## ACR

两轮实审。第一轮 error-handling-enforcer 判 **no**(SC11「trace 写入抛错」与继承的 ADR-0003 D13「`recordXxx` MUST NOT throw」冲突且未钉抛错层;ADR-0035「无条件面」的 trade-off 无 SSOT 落点;写侧新失败路径缺 EXIT 文档),另 minimal-change-verifier 指出一处 phantom(SC20 声称有注释引用不存在的 `src/harness/chat-session.ts`,全仓 grep 零命中)。按处方修 SC11 / SC20 / 待写入 / Constraints 后复审转 PASS。

```
bounded-context-guardian: yes — 改动全部落在既有缝内(session-api/store 目录解析、harness/trace 写侧、traceserver 读侧、todo-write 路径链),记录 vs 带锁活状态二分守住(逐条核对 SC1–SC20 无一触围栏或登记表),helpers.ts 不重叠声明经 grep 证实(该文件 todo|trace|session 零命中)。
defensive-contract-validator: yes — 表 A/B/C 对两个新表面各覆盖 empty/negative/overflow/concurrent/exception 五类,读写两侧期望分列;另有 SC15/SC17 基线逐字段相等断言;SC11 的测试为替换非删除(jsonl.test.ts:856 实证),写侧 exception 类覆盖强度不降。
error-handling-enforcer: yes — SC11 抛错层钉死于内层 blob IO(jsonl.ts:112 mkdirSync → :176 recordFailure warn-once → 返回 undefined),ADR-0003 D13/D14 继承与 ADR 原文(:26-:27)逐句吻合、不 amend;ADR-0035 trade-off 有 SSOT 落点(待写入限定条款);读侧 EXIT(:170)与写侧 EXIT 分列且各自钉死;无 magic string,沿用既有 typed 面。
complexity-anti-drift: yes — 单抽象层:一个纯函数解析(SC4,照抄 resolveSessionRoots 形状)+ 复用既有 dereferenceTraceMessages 而非二写 + SC7 消掉 options.traceDir! 可错参数对(复杂度只减不增);SC10 钉 messageRole() 源码零改动,粒度修订不新增读侧分支;无 god-flow。
minimal-change-verifier: yes — 一个逻辑任务(记录面归并;blob 唯一化因 ADR-0036 遗留的 rotation-orphans 悬置问题被文件夹寿命解掉而互为前提,拆开做会留两次孤儿语义);Phase 2 切分有真实前置依赖与独立 blast radius(resume 链)+ 已量化去重上限(mask 形态 vs secret 占位符形态),非人为劈半;L3 无兼容消除双读中间态,整个 cutover 可单 commit 原子落地。
OVERALL: PASS — hand to writing-plans
```

> 复审附带的一处非阻塞观察(已记入实施注意,不改判决):盘上的 ADR-0035 正文实为「subagent **生命周期** trace 无条件落盘」,而 SC11 影响的是 `llm_call` content 面。把限定条款挂到 0035 是可辩护的读法(目的正是消除「无条件」措辞的零前置暗示),且写入动作本身会把这个 scope 问题摆到 ADR 面上。

## 待写入

- **术语「会话文件夹(session folder)」**:harness 拥有的按会话记录面,分组键 = `projectIdentityRoot`,叶子 = `conversationId`;装 session 记录 / todos / trace / blobs / subagents。与「写根 = 模型工作面」对立。_Avoid_:把模型交付物放进来;把它当第五个根角色;用 session `title` 命名。
- **术语「模型实际所见 vs 耐久会话记录」**:trace 的 `messages` = 前者(含 `<agent_status>` 尾部注入、worker prior messages、compaction 后摘要视图、mask 形态),session jsonl = 后者(增量事件链表)。**两者故意不相等**,实测同一会话 `agent_status` 在 trace 14 次 / session 11 次。
- **术语「内容寻址正文池(blobs)」**:定长 sha256 作文件名、正文另存、write-if-missing;是**命名用法**不是摘要用法,原文一字不少。寿命 = 会话文件夹。
- **ADR-0036 amend**:去重粒度 整条 message → content(`role` 内联);opt-in → 唯一模式;删故障回退(**永不写内联全量行**);**补记它漏掉的代价**——`query_trace` 三个 preview 静默失效且与合法空态不可区分(`query-trace-core.ts:225-244` + `:235-238`)。
- **ADR-0035 amend(已落盘)**:记两项 —— (a) `<traceDir>` 移入会话文件夹、stderr 指针跟随、`createTrace("subagent")` 全机聚合退役改 per-agent;(b) **明确本 ADR 的无条件保证未被削弱**:`blobs/` 可写前置只作用于 content 面,生命周期三类事件不含 messages 正文、`toBlobReferences` 从不触发,故仍照常落盘。新增 trade-off:两面敏感度分化,取证须知「`llm_call` 缺席 ≠ 那次调用没发生」。
- **ADR-0003 D13 / D14 —— 继承,不 amend**:D13「`TraceService.recordXxx` MUST NOT throw」(接口 `@throws never`,经 `safeTrace` 集中)与 D14「`recordLlmCall` 返回 `undefined` 时 `recordToolCall` 仍被调用,`parent_llm_call_id: null`」**原样保留**。SC11 的「不留故障回退」只作用于**存储形态**(不再有内联全量行这条路),不作用于**异常契约**。写入此条是为防实施时把 fail-closed 误读成「向调用方抛」。
- **ADR-0071(新增)**:承载本轮两个新决策 —— 会话文件夹归并(五锚点 → 一,记录 vs 带锁活状态二分),以及新不变量「**trace 不得引用 session 记录**」(从增量事件流重算累计数组是**重算不是查表**,会漂移,违反 ADR-0036「所见即所填」)。
- **ADR-0036 误引修正**:它把「所见即所填」溯源到「ADR-0014 验收纪律」,但 ADR-0014 实为「Subagent spawn 语义」,该短语全仓只出现在 ADR-0036 自己正文里。amend 时把溯源收回 ADR-0036 自身。
- **ADR-0003 收窄**:「JSONL the dev can grep」在 messages 正文维度让位给内容寻址;事件行 / `tool_call` 参数 / `status` / `error` 维度不变。
- **ADR-0027 amend**:session 记录位置从 `<base>/sessions/<slug>/` 移入会话文件夹。
- **`resolveProjectSessionDir` 名实相符的交代**:它此前解析的是 cwd 不是 project。

## Assumptions(本 session 已确认,不再当作 Open Questions)

1. `<surface>` 层退役,todos 进会话文件夹,不做旧路径兼容 / 不迁移 / 不加 fail-fast 检测。
2. 会话文件夹布局 `~/.iknow/projects/<项目 slug>/<conversationId>/`,分组键 = `projectIdentityRoot`。
3. 旧存量不兼容:127 个会话目录 + 337MB trace 弃用,`--resume` 对旧会话失效。
4. trace 进会话文件夹,`blobs/` 为其兄弟目录,寿命 = 会话,删文件夹即回收。
5. blob 去重成为唯一模式,`MessageStorageMode` / `resolveMessageStorageMode` / `IKNOW_TRACE_MESSAGES` 退役。
6. 不留故障回退 = **永不写内联全量行**;异常契约仍守 ADR-0003 D13(内层 IO 失败 → warn-once → `recordLlmCall` 返回 `undefined` → 该次调用零行落盘 → turn 存活),**不**向调用方抛。
7. 去重粒度 = content,`role` 内联,`messageRole()` 零改动。
8. 保留 sha,不用位置指针。
9. trace 不得引用 session 记录(语义故意不等),作为新不变量落在 **ADR-0071**;不变量的既有 SSOT 是 ADR-0036「所见即所填」(**不是** ADR-0014,ADR-0036 那条溯源是误引,一并修正)。
10. 337MB 旧 trace 归档不删除。
11. **Phase 2 不进本 spec**,单列后续(要动 resume,收益仅 12M;Phase 1 拿 82% 且不碰 resume)。
12. **会话文件夹名用 conversationId(UUID),不用 worktree label**(操作员明确纠正)。
13. 归档位置 `~/.iknow/archive/trace-legacy/`(不进仓库 `archive/`,那个未被 gitignore,337MB 有误提交风险)。
14. `tool-results/` 只进**目录契约**,写入实现单列后续(要动 `sandbox/runner.ts:17` 截断权威)。
15. 子代理 `subagents/` 嵌套**进**本 spec(归并布局本身要求回答子代理记录放哪)。
16. 子代理 `backgroundManager` + 登记表所有权**不进**本 spec(能力面,ADR-0021 轴);`"subagent"` 假 scope 记为 L2。
17. chat REPL 缺 `conversationId` 不修(操作员只做 TUI,TUI 经 `hub.ts:1459` per-run 注入是干净的),但过时注释重写。
18. traceserver 三工具寻址变更**进**本 spec,作为独立一组 SC(Phase 1 里风险最高的一块)。
19. 网络三件 out of this spec(操作员:等会儿再说)。
20. `vitest.config.ts:22` exclude glob 修复不进本 spec(本地噪音,无因果关系)。

## 后续(本 spec 不做)

1. **Phase 2 — session 记录加入同一 blob 池**:消掉残留 12M 跨文件双写,达成「原文只有一份」。代价:amend ADR-0027 记录形状、**resume 链路必须解引用**(`specs/session-jsonl-resume.md`)、session 正文不可 grep。去重上限:trace 写前 mask(`jsonl.ts:117-118`)而 session 落 secret **占位符形态**(#406 roundtrip)→ 含 secret 的消息两边 sha 不同,那部分去不掉。**Phase 1 是其前提**:blob 机制与读侧解引用必须先存在。
2. **`tool-results/` 写入实现**:前台 bash 输出超 `DEFAULT_MAX_OUTPUT_CODE_POINTS = 12_000`(`sandbox/runner.ts:17`)时溢出**直接丢弃**,无任何读回通道;分页读回目前只对 `background:true` 存在(`bash_output`,默认 12 KB / 上限 100 KB,`bash.ts:254`)。参考两个都有对应物(Claude Code `tool-results/<toolUseId>.txt`;openharness `read_task_output(task_id, max_bytes=12000)` → "Return the tail of a task's output file",**默认值与 iknow 同为 12000**)。要动截断权威,独立 blast radius。
3. **子代理能力面**:worker 装配注入 `backgroundManager`(`worker.ts:372` 现不传 → `registry.ts:781` 剥掉 `bash_output` / `bash_stop`);后台登记表所有权(父子共用一张 vs 各一张 —— 共用则打破 `registry.ts:291` 的 D6「跨 executor 竞态由装配期排除」,改由 `conversationId` scope 运行期兜;各一张则子代理结束后后台进程成孤儿,而 `build-engine.ts:1628` 的 shutdown 收尸只在主 loop);以及修掉 `conversationId: "subagent"` 假 scope(L2)。
4. **chat REPL 注入 `conversationId`**:`cli.ts:364-368` 的 `chatDeps` 缺该字段,而 rebind 路径(`chat-session.ts:430`)又补上 → todo ledger 与后台任务 scope **中途翻转**(建树前全机 chat 会话共用一份 todos.md、`bash_output` 看得见全机任务;建树后切到空的 per-conversation 文件)。修法建议照 rebind 已验证的形状回写一次 deps。
5. **网络三件**(ADR-0022 轴):每次 `network:true` 获批的调用进 trace 审计;批准文案点名「这一路**不经 network-guard**、拿到完整宿主 netns 含 link-local metadata」(现 `policy.ts:97` 只说 "changes the fence shape");资格前置设置(**须诚实标注为资格门禁而非安全边界**)。域名过滤仍不做,根据:过滤只能在进程自愿经过的出口点生效,bash 里是任意代码不自愿;要非自愿就得 netns 重定向,而 bwrap 在非特权 user namespace 建不了 veth。
6. **`vitest.config.ts:22`**:exclude 只有 `archive/**`,漏 `_archive/**` → 未跟踪的 `_archive/worktrees-2026-08-25/restore-tui-banner/tests/tui/banner-lines.test.ts` 被收集并失败(2 fail,报 "Cannot find module '../../src/tui/banner.js'")。独立一行修。
