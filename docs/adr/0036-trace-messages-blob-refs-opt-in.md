# 0036. trace messages blob 引用模式（opt-in，默认 full）

Date: 2026-08-28
Status: accepted

背景：实测 trace/ 目录 263.5MB 中 98.2%（226.5MB）是 llm_call 行内全量累计消息历史的逐字节重复（单行最大 891KB），写侧「无 size cap」是 ADR-0014 验收纪律的刻意决策（保「模型实际所见」），不得截断。决定：新增 opt-in 存储模式 `IKNOW_TRACE_MESSAGES=blob`（默认 `full` 与现状 byte-shape 完全兼容）——blob 模式下 messages 元素替换为内容寻址引用 `{sha, bytes}`、正文 mask 后写 `<traceDir>/blobs/<sha>`（write-if-missing）。`messages_captured` 捕获语义不变：捕获的仍是模型实际看到的完整消息集，变的只是物理存储（去重）。

**Why not delta/off 写侧模式**：实质修订 ADR-0014「所见即所填」不变量，且打爆 `tests/e2e/subagent-foreground-trace.test.ts:164` 的 `messages_captured===true` 断言；引用模式保不变量地消灭同一冗余。**Why not 只做读侧投影**：磁盘 O(n²) 膨胀与 maskJsonLine 对多 MB 行的 per-line 重建 CPU 只有写侧去重能根治。

**负面 / Trade-offs:** blob 模式下 JSONL 行内不可再直接 grep message 正文（正文在 `blobs/<sha>`，按 sha 可达）——ADR-0003「JSONL the dev can grep」在默认 `full` 下继续成立，blob 开启者以可 discovery 的 sha 引用为代价换 7x 磁盘收益；`blobs/` 需要回收策略（rotation orphans 规则，PLAN 细化）。

## Amendment 2026-09-08（ADR-0071）

本 ADR 的核心决定（messages 元素换成内容寻址引用、正文 mask 后写 `blobs/<sha>`、write-if-missing、`messages_captured` 捕获语义不变）**原样成立**。以下三项被修订：

**1. 去重粒度：整条 message → `content`（`role` 保持内联）。** 原设计把整个 message 元素换成 `{sha, bytes}`，`role` 一并丢失。这是**设计失误**，不是取舍：读侧 `query_trace` 直接吃原始 row（`query-trace-core.ts:225-244`），`messageRole()`（`project-tool-results.ts:48-51`）对 `{sha,bytes}` 返回 undefined。改为 `{"role":"user","content":{"sha":…,"bytes":…}}` 后 `messageRole()` **零改动**即可正确分类，读侧只需在 preview 一处补 content 级解引用（复用既有 `dereferenceTraceMessages`）。去重收益不变——重复的是正文，`role` 那几个字节无关紧要。

**2. opt-in → 唯一模式。** `IKNOW_TRACE_MESSAGES` / `MessageStorageMode` / `resolveMessageStorageMode` 退役。根据：本 ADR accepted 九天后实测 `blobs/` 目录**在盘上不存在**、`trace/` 仍为 337MB / 82 文件——**默认关闭的开关等于功能不存在**。

**3. 删故障回退，但不动异常契约。** blobs 写不进去时**永不写内联全量行**（原「falls back to the masked full row」路径退役）。但抛错层钉死在**内层 blob IO**：经既有 `safeTrace` / recordFailure warn-once 吞掉 → `recordLlmCall` 返回 `undefined` → 该次调用零行落盘 → turn 存活；按 ADR-0003 **D14** 下游 `recordToolCall` 仍落 `parent_llm_call_id: null`。**ADR-0003 D13（`recordXxx` MUST NOT throw）原样继承，不 amend。**

**本 ADR 当年漏记的代价（补记）**：Trade-offs 段只记了「blob 模式下 JSONL 行内不可再直接 grep message 正文」，**漏记了粒度失误导致的读侧静默失效**——`first/last_message_preview` 会渲染成 `{"sha":…}` 死预览，而 `last_assistant_preview` 会**静默消失**，且因 `query-trace-core.ts:235-238` 明写「字段缺席 = 合法态（无 assistant 消息）」，**故障与合法空态不可区分**。受害的正是 `:230-232` 说的「外部 agent 取最终 assistant 结论的动线」。判断：这才是本 ADR 当年敢做却默认关的真实原因，而它没被写进 Trade-offs。粒度修正（第 1 项）后该失效消失。

**悬置项已被承接**：本 ADR 的「`blobs/` 需要回收策略（rotation orphans 规则，PLAN 细化）」从未细化。ADR-0071 把 `blobs/` 放进**会话文件夹**、寿命 = 会话，回收退化为「删文件夹」，不需要引用计数或全局 GC，也不会出现 trace 还在而 blob 被 rotation 清掉的孤儿态。附带简化：`traceDir` 可由 `dirname(traceFilePath)` 派生，消掉 `project-tool-results.ts:161` 那个 `options.traceDir!` 非空断言的可错参数对。

**误引修正**：本 ADR 的 Why-not 段把「所见即所填」不变量溯源为「ADR-0014 验收纪律的刻意决策」。实测 `docs/adr/0014-subagent-foreground-spawn-default.md` 是「Subagent spawn 语义：前景同步为默认契约」，全文不含该短语；「所见即所填」**全仓只出现在本 ADR 正文里**，是本 ADR 自己的措辞。ADR-0014 `:46` 只是把 trace 当验收 ground truth（`messages_captured` 断言模型实际看到的 system prompt），不等于拥有该不变量。此后引用一律指向本 ADR。

**正面 / Applied（本次新增）**：粒度修正让读侧改动从「三个 preview 字段全坏 + 无法按角色分类」缩到「preview 一处补解引用」；唯一模式 + 会话文件夹寿命一起把 348MB 降到约 62MB（−82%）。

**负面 / Trade-offs（本次新增）**：ADR-0035 的崩溃取证完整性获得一个 **content 面**前置（`blobs/` 可写）；生命周期面不含 messages 正文故不受影响，两面敏感度从此不同——取证时须知「`llm_call` 缺席 ≠ 那次调用没发生」。

Evidence pointers: 2026-08-28 定量分析（99 文件 263.5MB、重复率 98.2%、去重后 37MB）；ADR-0006 落盘否决的域区分（可再生工具输出 ≠ trace 存储格式）；ADR-0071（会话文件夹归并与 trace 正文内容寻址）；2026-09-08 复测（`trace/` 337MB / 82 文件、`blobs/` 不存在、同一会话 trace 41 行 264K vs transcript 88 行 72K）。
