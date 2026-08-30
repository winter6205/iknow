# Spec: lsp-mcp-server — stdio MCP server 暴露 10 件只读 `lsp_*`（SDK 2.0）

> 输入：操作员 2026-08-30「做成 SDK 2.0 的 MCP 服务」+ 先前抽取裁决（library 核 + MCP 表面，不做 Cursor plugin；写工具首版不带）。
> 对标：`specs/trace-mcp-server.md` 的 SDK / 分发形态。

## Assumptions

1. SDK = 根依赖 `@modelcontextprotocol/server` ^2.0.0；`serveStdio` + `McpServer.registerTool`；不设 `legacy: 'reject'`。
2. 同仓 bin `iknow-lsp-mcp`，不独立拆 npm 仓。
3. 工具面 = 现役 10 件只读 `lsp_*`（Y1 字符串）；无 rename/format/codeAction。
4. 连接池可实例化（`LspClientPool`）；MCP 自持一份，SIGTERM `disposeAll`。
5. `resolveBin` 为可注入缝；缺省仍解析 iknow `node_modules` + PATH。
6. `--root` > `IKNOW_LSP_ROOT` > cwd；空/非目录启动 fail-fast。
7. MCP 可调用 `createLspToolSet`（ACI 工具工厂，不是 registry）；不 `registerExternal`。

## Objective

外部编码 agent 经 MCP stdio 对本地项目做符号定位，与 iknow 进程内 `lsp_*` 同一套客户端语义。

## Boundaries

- **Does:** `LspClientPool` + `resolveBin`；`src/lsp-mcp/` + bin + docs 示例；10 件 read-only tools；vitest in-memory + 启动校验。
- **Out of this spec:** Cursor plugin；写类 LSP；独立发包；HTTP MCP；Go/Rust server。

## Success Criteria

1. `npx vitest run tests/lsp-mcp tests/harness/lsp/client.test.ts` EXIT 0。
2. In-memory `tools/list` 恰好 10 个 `lsp_*` 且 `readOnlyHint: true`。
3. 非法参数 → tool `isError`，会话可继续。
4. 缺失 `--root` 目录 → stderr 可读、exit ≠ 0、stdout 空。
5. 源码无 `legacy: 'reject'`。
6. 两个 `LspClientPool` 不共享缓存（client 单测）。

## ACR

```
bounded-context-guardian: yes — 连接池/bin 缝在 src/harness/lsp；MCP 仅 src/lsp-mcp transport；不进 ACI registry
defensive-contract-validator: yes — empty root；negative 非法 args；overflow files max 10 继承 ACI；exception 启动 fail-fast + handler isError
error-handling-enforcer: yes — 启动 typed LspMcpRootError；handler catch → isError；dispose 不 kill
complexity-anti-drift: yes — 一池一类 + MCP 薄注册循环；无新 god-file
minimal-change-verifier: yes — 本批 1 commit：池缝 + MCP 壳 + 测 + bin（与 Batch 1 已提交分离）
```
