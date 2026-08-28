# Plan: 思考折叠结束态去掉 `[思考]` 回落

**Goal:** 结束态只有一种文案语言：`思考了 N 秒`。秒数缺失/非正时不换括号标签 `[思考]`（不画该行 / 工具摘要只留计数）。进行中仍是 `思考中…`。
**Approach:** 改 `formatThinkingFold` SSOT；`formatTurnActivityFold` 无秒时只拼工具计数；MessageBlocks 空折叠行不渲染。
**Tracker:** 二次修复（相对 #775 的双文案，本变更独立落在 master）
**ACR:**

```
bounded-context-guardian: yes — 只动 tui 折叠文案 SSOT（think-fold / turn-activity / message-blocks），不跨 capability
defensive-contract-validator: yes — empty/0/undefined、负值、NaN/非有限、overflow 大秒数、无秒有工具
error-handling-enforcer: N/A — 纯格式化，无失败路径
complexity-anti-drift: yes — formatThinkingFold 保持单层分支，不扩 ChatView
minimal-change-verifier: yes — 1 逻辑任务、1 commit
```

## Tasks

1. **RED/GREEN：formatThinkingFold 无秒 → 空串** — tag: `[implementation]`
2. **配套：turn-activity / MessageBlocks / 既有 TUI 测试合同**
