# 0116. llm_call jsonl 补 system / tool_names，MCP 按窗读

Date: 2026-09-21
Status: deprecated

曾把本步发出的 identity `system` 全文（blob 引用）和广告给模型的 `tool_names` 写入 `llm_call`，读侧加 `detail=system` / `detail=tools`。操作员判定这不是产品主路径：日常排障不靠这两项；要的是 trace 能看到 **LSP / MCP 实际调用了哪些工具**（调用记录，不是本步工具广告表 + 系统前缀全文）。

本决策作废。`llm_call` 不再落 `system` / `tool_names`。调用面仍以既有 `tool_call.tool_name` 为准。Amends 曾改过的 ADR-0014 D6 已随回退恢复（proactive 关键词不再钉在 captured system 上）。
