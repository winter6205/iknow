# 578 — live tail 幽灵失败行 + 单文件 HTML 写得下

## Summary

Issue 578：`write_file` 因 `max_tokens` 截断缺 `content` → `validation_failed`；无 `tool_call_start` 时 `liveToolReduce` 对 unmatched `post_tool_use` append 一条 failed live 行，与 history `[失败]` 双重渲染，turn 结束后清空。

用户验收另要求：iknow 能写完基本「奢侈品腕表」自包含 HTML。根因是默认 `maxOutputTokens=8192` 装不下 thinking + 整段 `write_file` JSON（腕表页大于先前贪吃蛇页）。

**不改** permission-executor postToolUse（过滤 `validation_failed` 会让 running 挂死）。**不改** loop-engine / adapter 截断语义。**不改** 默认 `timeoutMs`（blast 过大；smoke 用 env 覆盖）。

## Affects

- src/tui/live-tool-state.ts
- tests/tui/live-tool-state.test.ts
- src/config/env.ts
- tests/config/env.test.ts
- docs/llm-config-quickstart.md
- docs/integration-materials.env.example
- CHANGELOG.md

## 5-line verdict block

bounded-context-guardian: yes — TUI live-tool reducer 与 config/env fallback 分属既有 capability 切片，无新目录、无跨 context 反向 import。
defensive-contract-validator: yes — TUI：empty prev unmatched post_tool_use / negative mismatched id / 匹配失败 in-place 回归；config：未设 env fallback / 显式覆盖。overflow/concurrent/exception 对本纯函数不新增行为。
error-handling-enforcer: yes — 不新增 catch；unmatched 失败走 history `tool_result`；截断仍由既有 truncation 路径处理。
complexity-anti-drift: yes — `liveToolReduce` unmatched 分支改为 `return prev`；env fallback 常数替换；不加深嵌套。
minimal-change-verifier: yes — 两件逻辑任务分两次 commit（TUI 幽灵行；maxOutputTokens 8192→16384），diff 不混 permission-executor / loop-engine。

## Tracer bullets

1. [implementation] TUI：RED unmatched append 测试 → reducer 不 append
2. [implementation] config：RED 默认 16384 → fallback + 文档示例 + CHANGELOG
