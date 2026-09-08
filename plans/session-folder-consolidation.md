# Plan: 会话文件夹归并与 trace 正文内容寻址

**Goal:** 同一个会话的记录面从五个锚点收进一个会话文件夹;trace 的 O(n²) 正文重复收成 content 级内容寻址,348MB → 约 62MB。
**Approach:** ADR-0071 已落盘(含 0036 / 0035 / 0003 / 0027 四份同日 Amendment)。**先地基后成员**:会话文件夹解析(纯函数)落地并让 SessionStore 真切过去,再并行迁 todos 与 trace 锚点,再做 blob 唯一化与粒度修正,然后才动读侧三工具,最后重建 `dist/trace-mcp` + 归档旧存量。不按 expand→migrate→contract 三段走 —— L3 明确不兼容旧存量,没有双读中间态要维持。
**Spec link:** `specs/session-folder-consolidation.md`
**ACR:** PASS(两轮;第一轮 error-handling-enforcer 判 no,按处方修 SC11 / SC20 / 待写入后复审转 PASS)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch;全部 bullet 落地后再跑一轮 `code-review`。

**Tracker:** 本地 markdown(fallback)。理由:操作员本轮明确要求不开 GitHub issue,且本 plan 与另两份正在执行的 plan(`plans/write-situation-disclosure.md`、`plans/worktree-exclusive-lock.md`)同属一轮讨论产出,统一不拆 ticket。

## ACR

```
bounded-context-guardian: yes — 七个 bullet 各落在一个既有 context 内:T1 session-api/store、T2 aci/tools/todo-write、T3a/T3b harness/trace 写侧、T4 traceserver 读侧、T5 harness/subagent + trace 装配、T6 构建产物与盘上存量、T7 决策。无新层目录;跨 bullet 只经会话文件夹解析这一个新缝通信。
defensive-contract-validator: yes — spec 输入五类三张表按 bullet 分配:T1 吃表 A(路径解析五类)、T3b 吃表 B(blob 读写五类)+ 表 C(content 两种形状 + 混合)、T4 吃 SC15/SC17 的 full-vs-blob 基线逐字段相等断言。并发项(同 conversationId 建目录、同 sha write-if-missing)分别钉在 T1 与 T3b。
error-handling-enforcer: yes — SC11 的抛错层在 T3b 钉死(内层 blob IO → safeTrace/recordFailure warn-once → undefined → 零行落盘 → turn 存活),ADR-0003 D13/D14 明列继承不 amend;T1 的表 A exception 行要求 typed 冒泡且绝不降级到别的锚点;T4 保留读侧「blob 缺失不抛进 turn」的既有 EXIT(project-tool-results.ts:170)。
complexity-anti-drift: yes — 每 bullet 一个缝:T1 一个纯函数(照抄 resolveSessionRoots 形状)、T4 复用既有 dereferenceTraceMessages 而非新写、T3a 顺带消掉 options.traceDir! 可错参数对(复杂度只减不增)。无 bullet 引入 god-flow;worktree-gate.ts 那类已超 500 行的文件本 plan 不碰。
minimal-change-verifier: yes — 一 bullet 一 commit,七个 commit 各自可独立验证;能力面三条(Phase 2 / tool-results 写入 / backgroundManager)与网络三件显式留在 spec「后续」,不进本 plan;L3 无兼容使每个 bullet 都不需要维持双读路径。
```

## 待写入

(空 —— ADR-0071 与三份 CONTEXT 词条「会话文件夹」/「模型实际所见」/「内容寻址正文池」已在 specify persist flush;0036 / 0035 / 0003 / 0027 四份 Amendment 同步落盘。)

## Tasks (ordered by dependency)

1. **会话文件夹解析 + SessionStore 切过去** — tag: `[implementation]`
   - **Inherits:** ADR-0071 Decision 1/2/7;spec SC1–SC4、输入五类表 A;CONTEXT「会话文件夹」词条;`projectIdentityRoot`「跨 session worktree rebind 不变」
   - **Surface:** `src/session-api/store`(既有 `resolveProjectSessionDir` 缝)+ `src/session-api`(SessionStore 消费面)
   - **Acceptance:** 同一 `projectIdentityRoot` + 两个不同 cwd(主仓 / 其 task worktree)解析到**同一路径**(SC1);叶子是 conversationId 原文、不含 label / title(SC2);slug 形式仍是 `<basename>-<sha1[:12]>`(SC3);解析是纯函数、缺根/空白/相对/不可规范化 typed fail-closed 且**绝不**回退 `process.cwd()`(SC4 + 表 A empty/negative/overflow/exception);两进程同建一个会话文件夹不产生半建态(表 A concurrent);新建会话后 TUI 列表能看见、`--resume` 能续跑(端到端可演示)
   - Status: [ ] pending

2. **todos 进会话文件夹,`<surface>` 层退役** — tag: `[implementation]`
   - **Inherits:** ADR-0071 Decision 2;spec SC5、SC20;Assumption 1(不兼容旧 ledger);既有两段式缝(装配期注入根 + 调用期按 `ctx.conversationId` 拼);**ADR-0046** —— replace 模式把旧账本重命名成**同目录快照** `todos.<unixMs>.<hex>.md`(`todo-write.ts:347-358`,用 `dirname(filePath)`),故快照随归并自动进会话文件夹,**快照逻辑不需改**;ADR-0046 原文「旧文件留在**同一会话目录**当快照」与工具描述「`<session>/todos.md`」(`:119`)此前只是愿望(实际是 `<surface>` 共享根),归并后成为事实
   - **Surface:** `src/harness/aci/tools/todo-write` + 三个注入点(`cli.ts` / `tui/deps.ts` / `session-api/hub.ts`)
   - **Acceptance:** `todo_write` 落 `<会话文件夹>/todos.md`,状态栏投影读同一份(SC5);`resolveSessionTodoDir` 在 `src/` grep 为空、任何路径不出现 `todos/chat|serve|tui`(SC5);**同一会话从 TUI 与从 serve 各跑一次,todo 落同一文件**(这是 `<surface>` 分裂的可观察消除);**replace 后旧账本成为 `<会话文件夹>/todos.<unixMs>.<hex>.md`,与 `todos.md` 同目录**(ADR-0046 快照不丢、不散落到别处);SC20 四条注释断言全过 —— 含 `todo-write.ts:432` 那条裸引用 `chat-session.ts:963` 修正为真实位置 `src/cli/chat-session.ts:2062`(实测漂移约 1100 行)
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel]

3. **trace 锚点迁入会话文件夹 + traceDir 派生** — tag: `[implementation]`
   - **Inherits:** ADR-0071 Decision 1;ADR-0035 同日 Amendment(stderr 指针跟随、per-agent 面由 T5 承接);spec SC6、SC7
   - **Surface:** `src/harness/trace` 写侧装配 + `src/cli.ts`(`DEFAULT_TRACE_DIR` 退役)+ trace 注入点
   - **Acceptance:** `DEFAULT_TRACE_DIR = "./trace/"` 退役(SC6);从仓库根与从其 task worktree 各启动同一会话 → trace 落**同一文件**(SC6 的可观察判据);仓库根不再新增 `trace/`;`blobs/` 与 `stderr/` 是 `trace.jsonl` 的兄弟目录;`traceDir` 由 `dirname(traceFilePath)` 派生,`project-tool-results.ts:161` 的 `options.traceDir!` 非空断言**消失**(SC7)
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel]

4. **blob 唯一化 + content 级粒度 + 删故障回退** — tag: `[implementation]`
   - **Inherits:** ADR-0036 同日 Amendment 三项;ADR-0071 Decision 3/4/5;ADR-0003 D13/D14 **继承不 amend**;spec SC9–SC13、输入五类表 B + 表 C
   - **Surface:** `src/harness/trace`(写侧 `toBlobReferences` 与模式解析)+ `tests/harness/trace`
   - **Acceptance:** `IKNOW_TRACE_MESSAGES` / `MessageStorageMode` / `resolveMessageStorageMode` 在 `src/` grep 为空(SC9);`messages[i]` 仍是 `{role, content}` 两键、`content` 为 `{sha,bytes}`,`messageRole()` **源码零改动**且返回正确 role(SC10);`blobs/` 不可写时五条可观察断言全过 —— 该 `llm_call_id` 零行、无任何内联全量行、`recordLlmCall` 返回 `undefined` 而不 throw、同轮后续 `tool_call` 仍在场且 `parent_llm_call_id` 为 `null`、loop 不中断(SC11,替换而非删除 `jsonl.test.ts:856`);同一 message 出现在 N 个 `llm_call` → `blobs/` 下恰好 1 个文件(SC12);mask / `bytes` / `sha` 三条完整性断言保持(SC13);表 B 五类 + 表 C 三种形状(数组 / 字符串 / 混合)各有用例
   - Status: [ ] pending
   - [blocks: T3]

5. **子代理记录嵌套进 `subagents/`** — tag: `[implementation]`
   - **Inherits:** ADR-0071 Decision 1;ADR-0035 同日 Amendment(`createTrace("subagent")` 全机聚合退役);spec SC8、L2
   - **Surface:** `src/harness/subagent` + trace 装配(`hub.ts` / `cli.ts` / `tui/deps.ts` 的 `subagentTrace` 注入)
   - **Acceptance:** 派一个子代理跑完 → `<父会话文件夹>/subagents/agent-<id>.jsonl` + `.meta.json` 落盘,meta 至少含 `{agentType, toolUseId, spawnDepth}`(SC8);归并后 `~/.iknow/projects/**/` 顶层**不存在** `agent-*` 目录(SC8);`<id>` 取子代理自身 spawn id 而**不是** conversationId —— 因为 worker 的 `conversationId` 是硬编码字面量 `"subagent"`(L2,`cli.ts:295` / `tui/deps.ts:262`),断言需显式覆盖「两个并发子代理落到两个不同文件」;`createTrace("subagent")` 那种单文件聚合形态在 `src/` grep 为空
   - Status: [ ] pending
   - [blocks: T3]
   - [parallel]

6. **读侧三工具走两级树 + `query_trace` 补 content 解引用** — tag: `[implementation]`
   - **Inherits:** ADR-0071 Decision 3/6;spec SC14–SC17;ADR-0003 同日 Amendment(greppability 收窄只及 messages 正文)
   - **Surface:** `src/traceserver`(`list-sessions-core` / `query-trace-core` / `get-record-core` / `project-tool-results`)
   - **Acceptance:** `query_trace` 的 `first/last_message_preview` 是**正文**且不含 `"sha"` 字面量、有 assistant 消息时 `last_assistant_preview` **必须在场**(SC14,这条修的正是与合法空态不可区分的静默失效);`messages_count` / `tool_result_count` / `tool_result_previews` 与 full 模式历史基线**逐字段相等**(SC15);`list_sessions` 走两级树、返回的 id 集合与磁盘会话文件夹名集合相等、`agent_version` 取得到、`mtime`/`size` 语义择一并在测试钉死(SC16);`get_record` 两臂的 part 坐标 / `part_chars` / role 标注与基线一致(SC17);读侧「blob 缺失不抛进 turn」的既有 EXIT 保持;**`subagents/` 下的文件不得被 `list_sessions` 当成会话**(与 T5 的交互判据)
   - Status: [ ] pending
   - [blocks: T4, T5]

7. **`dist/trace-mcp` 重建 + 实跑验收 + 旧存量归档** — tag: `[implementation]`
   - **Inherits:** spec SC18、SC19、L3;ADR-0071 Decision 7;Assumption 13(归档不进仓库 `archive/`,实测它未被 gitignore)
   - **Surface:** 构建产物 `dist/trace-mcp` + 盘上存量(`~/projects/iknow/trace/` → `~/.iknow/archive/trace-legacy/`)+ CHANGELOG / handoff
   - **Acceptance:** 重建后**实跑**三个工具(`list_sessions` → `query_trace` → `get_record`)对同一真实会话返回互相一致的内容且 preview 为正文 —— 仅单测全绿不算完成,因为 `scripts/iknow-trace-mcp.cjs:6-12` spawn 的是构建产物(SC18);仓库根**不存在** `trace/`、归档目录文件数 == 82、`archive/` 下零新增、`git status` 干净(SC19);CHANGELOG 与 handoff 显式写出 L3(旧会话 `--resume` 全失效、TUI 列表清空)
   - Status: [ ] pending
   - [blocks: T6]

8. **`list_sessions` 扫描成本实测与索引决策** — tag: `[decision]`
   - **Inherits:** spec L1(触发重开条件已写在 spec:实测单次超 1s 则引入索引文件)
   - **Surface:** `src/traceserver/list-sessions-core` + 本 plan 文件(记录判定)
   - **Acceptance:** 在归并后的真实盘上(≥100 个会话文件夹跨 ≥5 个项目)实测单次 `list_sessions` 墙钟时间,数字写进本 bullet 的 Status 行;**≤1s → 判定 L1 关闭,不引入索引**;**>1s → 判定重开,把「索引文件」写成新 spec 的一条 Open Question**,不在本 plan 内实现。判定必须附实测命令与输出,不接受估算
   - Status: [ ] pending
   - [blocks: T6]
   - [parallel]

## 实施注意(不占 bullet,随对应 bullet 落地)

- **T2 与 T3 可并行**,但两者都要读 T1 的解析函数;若 T1 的函数签名在 T2/T3 落地过程中需要调整,回 T1 改一次再往下,不要在 T2/T3 各自绕一份(那会造出 ACR 明确否掉的影子副本)。
- **T4 的基线从哪来**:SC15/SC17 要求与 full 模式「历史基线逐字段相等」。基线必须在 T4 开工**之前**从 T3 落地后的盘上取一次并固定成 fixture,否则 T4 改完就没有对照物了。
- **T6 之前不要重建 `dist/trace-mcp`**:T3/T4 中途重建会让 MCP 处于「写侧已改、读侧未改」的半态,实跑验收会给出误导结果。重建只在 T7。
- **`vitest.config.ts:22` 的 exclude glob**(只排 `archive/**` 漏 `_archive/**`,导致 2 个未跟踪测试被收集而失败)与本 plan 无因果关系,按 Assumption 20 独立一行修,不混进任何 bullet 的 commit。
