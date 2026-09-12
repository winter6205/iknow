# 0071. 会话文件夹归并与 trace 正文内容寻址

Date: 2026-09-08
Status: accepted

> **Amendment 2026-09-13**（ADR-0088）：Decision 2「后台任务登记留在 `stateAnchor` / 工作区 `.iknow/tasks`」**superseded**。登记表仍不进会话文件夹叶子，但落在同一 home 项目树的 `tasks/` 兄弟目录。退役 `sessions/` 布局仍适用 Decision 7（不自动迁移）。
>
> **Amendment 2026-09-13**（ADR-0087）：会话池根是 `home/.iknow`（或显式 dataDir），不是 `<workspaceRoot>/.iknow`。Decision 1 的路径字面量原样有效；实现曾把 `baseDir` 绑到 workspace 分片，与本 ADR 冲突，现收回。

## Context

同一个会话的记录面散在**五个锚点**,彼此用同一个 `conversationId` 做键却不共享位置(实测 2026-09-08):

| 状态               | 锚点                                                                                         | 出处                                 |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| session transcript | `<dataDir>/sessions/<basename(cwd)>-<sha1[:12]>/`                                            | `session-store.ts:107-110`           |
| todos              | `~/.iknow/todos/<surface>/<conversationId>/todos.md`                                         | `todo-write.ts:450-456`              |
| 后台任务登记表     | `<stateAnchor>/.iknow/tasks`（现 `<pool>/projects/<slug>/tasks`，见上方 ADR-0088 amendment） | `build-engine.ts:667`(ADR-0021 D1.3) |
| trace              | `./trace/<conversationId>.jsonl`(**cwd 相对**)                                               | `cli.ts:77`                          |
| worktrees          | `<repoRoot>/.iknow/worktrees/<leaf>`                                                         | `worktree-gate.ts:548-556`           |

三处可实测的缺陷:

1. **分组键名不副实**:`resolveProjectSessionDir` 注释自称 "Project namespace",实际键是 `basename(cwd)`。cwd 随 worktree 改绑移动 → **同一项目的会话被劈成 N 个平级文件夹**。盘上 `~/.iknow/sessions/` 127 个目录里,`126-hook-system-3d7759ffa337`、`128-verify-loop-86751ccd061c`、`321-tui-opentui-migration-9d0906d38c93`、`653-hygiene-7dbf90da9ee6`、`820-75d95286e7ef` 全是同一个项目的不同 worktree。
2. **子代理平铺**:127 个目录里 **7 个是 `agent-*`**,与项目目录平级 → 父子关系在文件系统上丢失,`listSessions` 把子代理当同级会话列出。
3. **trace 的 O(n²) 双写从未被治**:ADR-0036 实测「263.5MB 中 **98.2%(226.5MB)是 llm_call 行内全量累计消息历史的逐字节重复**,单行最大 891KB」,方案已实现已测试,但 **opt-in 默认关,`blobs/` 至今不存在**。同一会话实测:trace 41 行 / 264K,transcript 88 行 / 72K —— **行数一半,体积 3.7 倍**。全库 trace 337M vs transcript 12M。

## Decision

**1. 引入「会话文件夹」,分组键 = `projectIdentityRoot`,叶子 = `conversationId`。**

```
~/.iknow/projects/<basename(root)>-<sha1(root)[:12]>/<conversationId>/
    <conversationId>.jsonl + .json    session transcript(ADR-0027,形状不变)
    todos.md
    trace.jsonl
    blobs/<sha256>
    subagents/agent-<id>.jsonl + .meta.json
    tool-results/
```

键取 `projectIdentityRoot` 而非 cwd,因为它「宿主启动时钉一次、跨 session worktree rebind 不变」(`docs/CONTEXT.md`)—— 正是分组所需语义。叶子用 conversationId 原文,**不**引入 label:会话没有对应的命名入口,且 `task worktree label` 的 _Avoid_ 明禁「用 session `title` / `goal` 当 slug」。展示面由上一层项目 slug 与记录内 `title` 字段承担。

**2. 判据是「记录 vs 带锁活状态」,不是「按会话与否」。**

append-only 的记录(transcript / todos / trace / blobs / 子代理记录)进会话文件夹;**带锁的活状态不进叶子** —— 后台任务登记表落在同一 home 项目树的 `tasks/` 兄弟目录(ADR-0088 / ADR-0021 D1.3)，改绑后仍看得见、树上不另开一份登记(ADR-0037 §4)；worktrees 留在 `repoRoot`。寿命与访问模式不同:记录随会话生死,活状态要跨改绑存活。

**3. blob 去重从 opt-in 改为唯一模式,去重粒度从整条 message 改为 `content`。**

ADR-0036 原设计把**整条 message** 换成 `{sha, bytes}`,`role` 一并丢失。改为保留信封:

```jsonc
{ "role": "user", "content": { "sha": "a3f…", "bytes": 1842 } }
```

理由:读侧 `query_trace` 直接吃原始 row(`query-trace-core.ts:225-244`),`messageRole()`(`project-tool-results.ts:48-51`)对 `{sha,bytes}` 返回 undefined → **`last_assistant_preview` 静默消失**,而 `:235-238` 注释明写「字段缺席 = 合法态(无 assistant 消息)」→ **故障与合法空态不可区分**;`first/last_message_preview` 渲染成 `{"sha":…}` 死预览。而 `last_assistant_preview` 正是 `:230-232` 说的「外部 agent 取最终 assistant 结论的动线」。保住 `role` 内联后 `messageRole()` **零改动**,读侧只需在 preview 一处补 content 解引用(复用既有 `dereferenceTraceMessages`)。

去重收益不变:重复的是正文,`role` 那几个字节无关紧要。`IKNOW_TRACE_MESSAGES` / `MessageStorageMode` / `resolveMessageStorageMode` 退役。

**4. `blobs/` 进会话文件夹,寿命 = 会话。**

这消掉了 ADR-0036 唯一悬置未做的项:「`blobs/` 需要回收策略(rotation orphans 规则,PLAN 细化)」。放在会话文件夹内,回收退化为「删文件夹」,不需要引用计数或全局 GC;也不会出现 transcript 还在、blob 被 rotation 清掉的孤儿态。附带简化:`traceDir` 可由 `dirname(traceFilePath)` 派生,消掉 `project-tool-results.ts:161` 那个 `options.traceDir!` 非空断言的可错参数对。

**5. 删故障回退,但不动异常契约。**

blobs 写不进去时**永不写内联全量行**(操作员明确要求)。但抛错层钉死在**内层 blob IO**:经既有 `safeTrace` / recordFailure warn-once 吞掉 → `recordLlmCall` 返回 `undefined` → 该次调用零行落盘 → turn 存活;按 ADR-0003 **D14**,下游 `recordToolCall` 仍以 `parent_llm_call_id: null` 落盘。**ADR-0003 D13(`recordXxx` MUST NOT throw)原样继承,不 amend。**

**6. 新不变量:trace 不得引用 session transcript 来重建 `messages`。**

两者语义**故意不等**:trace 的 `messages` 是「模型实际所见」(含 `<agent_status>` 尾部注入、worker prior messages、compaction 后摘要视图、mask 形态),transcript 是「耐久会话记录」(增量事件链表)。实测同一会话 `agent_status` 在 trace 出现 14 次、transcript 11 次;trace 的 role 序列出现 `user | user` 连续,那是注入痕迹。

从增量事件流得到「第 N 次调用的累计数组」**不是查表,是重算** —— 要重放 compaction、重放注入、重放 mask。重算就会漂移,一漂移就违反 ADR-0036「所见即所填」。**体积是浪费,语义错是撒谎**,故拒绝。

**7. 不做旧存量兼容。**

127 个会话目录不迁移,`--resume` 对旧会话失效,TUI 会话列表清空。仓库根 337MB `trace/` 归档至 `~/.iknow/archive/trace-legacy/`(**不进仓库 `archive/`** —— 实测 `archive/` 未被 gitignore,只有 `_archive/` 与 `/trace/` 被忽略,337MB 有误提交风险)。

## Why not

**Why not 让 trace 引用 transcript 的正文(消掉跨文件双写)**:见 Decision 6 —— 重算不是查表,会漂移。残留的跨文件重复上限只有 12M(transcript 全库体积),而代价是把「模型实际所见」这个取证语义押在「两份记录恒等」这个假前提上。

**Why not 保留 blob 的 opt-in 开关**:accepted 九天,`blobs/` 不存在,337MB 原样躺着 —— **默认关闭的开关等于功能不存在**。且它当年敢默认关的真实原因,判断是 Decision 3 那个静默失效(一开就打断 MCP 主发现动线),而 ADR-0036 只记了「不可 grep 正文」这一个代价,**漏记了这条**。粒度修正后该理由消失。

**Why not 位置指针(指向同一 trace 文件里首次出现的 `(llm_call_id, index)`)**:要维护首次出现索引,复杂度高于 sha,收益为零 —— sha + `flag:"wx"` write-if-missing 已经在物理上只存一份。

**Why not 把后台任务登记表也归并进会话文件夹**:它是 per-root 活状态,ADR-0037 §4 明确要求跨改绑可见。归并会破这条,且要重新回答孤儿子进程收尸(`build-engine.ts:1628` 的 shutdown 只在主 loop)。

**Why not 用 worktree label 命名会话文件夹**:会话没有 label 入口;若改用 `title` 则直接违反 `task worktree label` 的 _Avoid_。UUID 还免掉净化、撞名与「同名已存在则失败」三条规则。

## Consequences

**正面 / Applied:**

- 五锚点 → 二(会话文件夹 + 根锚点活状态),同一个 conversationId 不再落在两个不同根。
- trace 从 cwd 相对变为会话锚定:从主仓或从 worktree 启动同一会话,trace 落同一文件;337MB 不再挂在仓库根。
- 体积:按 ADR-0036 实测 7x 比率,348M → 约 62M(**−82%**)。
- 子代理 lineage 在文件系统上可见(`subagents/` 嵌套),`createTrace("subagent")` 那种全机聚合退役。
- `<surface>` 层消失,todos 不再因入口不同而分裂。

**负面 / Trade-offs:**

- **ADR-0003 greppability 收窄**:messages 正文不可再在 JSONL 行内 grep(按 sha 可达;事件行 / `tool_call` 参数 / `status` / `error` 维度不变)。
- **ADR-0035「无条件面」获得前置**:trace 的崩溃取证完整性现在**以 `blobs/` 可写为前置**;目录不可写期间该次 `llm_call` 整体不落盘(静默,按 D13)。操作员已授权。
- **读侧寻址契约变更**:traceserver 三工具从平铺 `<traceDir>/<conversationId>.jsonl`(`query-trace-core.ts:86`、`get-record-core.ts:112`)改为走两级树,`list_sessions` 扫描成本未实测(沿用「只读前 64 KiB」窗口;触发重开条件:单次超 1s 则引入索引文件)。
- **`dist/trace-mcp` 必须重建**:`scripts/iknow-trace-mcp.cjs:6-12` spawn 的是构建产物,源码改完不重建则 MCP 看不到变化。
- 旧会话全量失效(Decision 7)。

## Evidence pointers

- 归档 spec `docs/archive/025-retire-completed-specs-and-plans/specs/session-folder-consolidation.md`(SC1–SC20 + 输入五类三表 + ACR 两轮 PASS)
- 盘上实测(2026-09-08):`~/.iknow/sessions/` 127 目录 / 7 个 `agent-*`;`~/projects/iknow/trace/` 337M / 82 jsonl;`~/.iknow/sessions/` 12M;同一会话 trace 41 行 264K vs transcript 88 行 72K;`agent_status` trace 14 / transcript 11
- 参考形状:`~/.claude/projects/<slug>/<conversationId>/{tool-results/,subagents/}` + `~/.claude/tasks/<conversationId>/`(盘上实测;`tasks/` 抽样 8 个 uuid 全命中 `projects/*/<uuid>`,确认按 conversationId 键)。openharness 部分(`get_project_session_dir` / `read_task_output(task_id, max_bytes=12000)` → "Return the tail of a task's output file")来自 `~/.cache/codebase-memory-mcp/…upstream-openharness.db` 索引 docstring,**证据等级低于读源码**(源码已从 `.reference/` 清空)。
- **误引修正**:ADR-0036 把「所见即所填」溯源为「ADR-0014 验收纪律」,但 `0014-subagent-foreground-spawn-default.md` 实为「Subagent spawn 语义」,全文不含该短语;该短语全仓**只出现在 ADR-0036 自己正文里**。ADR-0014 `:46` 只是把 trace 当验收 ground truth。本 ADR 与 CONTEXT 词条的溯源一律指向 ADR-0036。
