# 0036. trace messages blob 引用模式（opt-in，默认 full）

Date: 2026-08-28
Status: accepted

背景：实测 trace/ 目录 263.5MB 中 98.2%（226.5MB）是 llm_call 行内全量累计消息历史的逐字节重复（单行最大 891KB），写侧「无 size cap」是 ADR-0014 验收纪律的刻意决策（保「模型实际所见」），不得截断。决定：新增 opt-in 存储模式 `IKNOW_TRACE_MESSAGES=blob`（默认 `full` 与现状 byte-shape 完全兼容）——blob 模式下 messages 元素替换为内容寻址引用 `{sha, bytes}`、正文 mask 后写 `<traceDir>/blobs/<sha>`（write-if-missing）。`messages_captured` 捕获语义不变：捕获的仍是模型实际看到的完整消息集，变的只是物理存储（去重）。

**Why not delta/off 写侧模式**：实质修订 ADR-0014「所见即所填」不变量，且打爆 `tests/e2e/subagent-foreground-trace.test.ts:164` 的 `messages_captured===true` 断言；引用模式保不变量地消灭同一冗余。**Why not 只做读侧投影**：磁盘 O(n²) 膨胀与 maskJsonLine 对多 MB 行的 per-line 重建 CPU 只有写侧去重能根治。

**负面 / Trade-offs:** blob 模式下 JSONL 行内不可再直接 grep message 正文（正文在 `blobs/<sha>`，按 sha 可达）——ADR-0003「JSONL the dev can grep」在默认 `full` 下继续成立，blob 开启者以可 discovery 的 sha 引用为代价换 7x 磁盘收益；`blobs/` 需要回收策略（rotation orphans 规则，PLAN 细化）。

Evidence pointers: `specs/trace-agent-readability.md`（Success Criteria 7）；2026-08-28 定量分析（99 文件 263.5MB、重复率 98.2%、去重后 37MB）；ADR-0006 落盘否决的域区分（可再生工具输出 ≠ trace 存储格式）。
