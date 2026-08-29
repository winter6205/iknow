# Plan: trace-mcp-server

**Goal:** 外部编码 agent 经 stdio MCP 调用与 ACI 同一套 `query_trace` 投影读本地 JSONL；先抽共享核，再挂 MCP 壳。
**Approach:** 两票两 commit——先把查询/投影核落到 `traceserver` 并让 ACI 薄包回归，再加 `@modelcontextprotocol/server` stdio 入口、bin 与 MCP 测。禁止混票、禁止代理 traceserver HTTP、禁止改 ACI 语义。
**Spec link:** `specs/trace-mcp-server.md`
**Tracker:** 操作员指定不开 GitHub issue；实施按本文件分 commit。
**ACR:** all-yes（2026-08-30，修订后复审 PASS）

```
bounded-context-guardian: yes — 共享核钉死 src/traceserver/ 且禁 harness import；src/trace-mcp/ 仅 transport；错误在 ACI/MCP 薄皮映射；不进 ACI registry
defensive-contract-validator: yes — empty SC10；negative SC4/SC9；overflow SC7；concurrent SC3；exception SC3 EXIT + SC10
error-handling-enforcer: yes — 核用域内 typed error；薄皮映射；blob EXIT；启动 stderr+非0；stdout 仅 JSON-RPC
complexity-anti-drift: yes — 一共享核 + ACI/MCP 两薄皮 + stdio 入口
minimal-change-verifier: yes — 两票两 commit；禁止混票与 HTTP/OTel/resources
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入

（空）— 无新 CONTEXT 词条；无新 ADR。可选：合并后在 #803 留一条「前置改为投影 SSOT 已存在」评论，不阻塞实施。

## Out of scope

MCP resources/prompts；HTTP/SSE transport；OTel；代理 traceserver HTTP；改写侧 / blob 默认 / rotation；扩展 `query_trace` 参数面；独立 npm 拆仓；记忆 MCP。

## Tasks (ordered by dependency)

1. **Extract shared `query_trace` core; ACI becomes a thin adapter** — tag: `[implementation]`
   - **Inherits:** spec Assumptions §5/§11 票①；SC1–SC4；核在 `src/traceserver/`、禁 harness import；域内 typed error → ACI 映射为既有 `QueryTraceValidationError` / `ToolExecutionError`；blob 失败保留 `// EXIT:`；投影与 4000 帽语义不变
   - **Surface:** `src/traceserver` + `src/harness/aci`（仅 `query_trace` 薄包）
   - **Acceptance:** 核文件无 harness import；`npx vitest run tests/harness/aci/tools/query-trace.test.ts tests/traceserver/project-tool-results.test.ts` EXIT 0；concurrent 投影测仍绿；非法输入经 ACI 仍呈既有 typed error
   - Status: [ ] pending

2. **Ship stdio MCP server skin + bin** — tag: `[implementation]`
   - **Inherits:** spec Assumptions §2–§4/§6–§9/§11 票②；SC5–SC13；`serveStdio` 默认 legacy（不设 `legacy:'reject'`）；唯一 tool `query_trace`；`--trace-out` > `IKNOW_TRACE_OUT` > `./trace/`；启动非法路径 fail-fast；参数非法 → tool `isError`；不进 ACI registry
   - **Surface:** `src/trace-mcp`（transport）+ 根 `package.json` bin/依赖 + 可复制 mcp.json 示例（spec 附录或 `docs/` 短节择一）
   - **Acceptance:** bin 可解析；In-memory（或等价）client `tools/list` 仅 `query_trace`；列表投影 ≤4000 且无 messages 全文；`record_id`/`detail` 对齐 ACI；非法参数 `isError`；非法 `traceDir` 启动 exit ≠0 + stderr；源码无 `legacy:'reject'`；`trace-mcp` 不碰 ACI registry；新增 MCP 测 `npx vitest run` EXIT 0且不进 `test:real-llm`
   - [blocks: T1]
   - Status: [ ] pending

## End of round

实施顺序：T1 → T2。全部合入后一轮 code-review + verification-before-completion。
