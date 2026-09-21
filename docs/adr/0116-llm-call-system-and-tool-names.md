# 0116. llm_call jsonl 补 system / tool_names，MCP 按窗读

Date: 2026-09-21
Status: accepted

#1077 是观测读写缺口，不是把「模型实际所见」从 messages 扩成三件套。MCP / ACI 读的是会话文件夹里的 `trace.jsonl`，没有第二份 wire 记录，所以写侧必须在 `recordLlmCall` 补上本步已发出、但现在没落盘的字段：`system`（`deps.system()` 全文；未发送则缺席）和 `tool_names`（名列表，不是 schema）。读侧 `get_record` 增 `detail=system`（沿用 part 窗）与 `detail=tools`；`query_trace contains` 解引用后能命中 usage 锁句。system 正文复用既有 **内容寻址正文池**，避免每行内联前缀。禁止把 identity 前缀塞进 `messages` 假扮 `role=system`。不改「模型实际所见」词条（仍只约束 messages vs transcript，ADR-0036）。Amends ADR-0014 D6：proactive 关键词打在这条 captured `system` 上，不要假装它在 messages 里。不改模型是否服从 usage（#1078）。
