# Spec: lsp-mcp-server — stdio MCP server 暴露 10 件只读符号查询（SDK 2.0）

> 输入：操作员 2026-08-30「做成 SDK 2.0 的 MCP 服务」+ 配置写 README、先不登记项目 mcp.json。
> 对标：`specs/trace-mcp-server.md` 的 SDK / 分发形态。
> 继承：`specs/symbol-primary-aci.md` Assumption 12（工具面与 ACI 查询面同构）+ T6 acceptance。

## Assumptions

1. SDK = 根依赖 `@modelcontextprotocol/server` ^2.0.0；`serveStdio` + `McpServer.registerTool`；不设 `legacy: 'reject'`。
2. 同仓 bin `iknow-lsp-mcp`，不独立拆 npm 仓。
3. 工具面 = 10 件只读符号查询（`find_symbol` / `find_declaration` / `find_referencing_symbols` / `find_implementations` / `get_symbols_overview` / `get_hover` / `get_diagnostics_for_file` / `prepare_call_hierarchy` / `list_incoming_calls` / `list_outgoing_calls`），与 `src/harness/aci/tools/symbol.ts` 的 `SYMBOL_QUERY_TOOL_NAMES` 一一对齐（同构）；入参是符号身份（`file` + `symbol_path`，或 `query`，或仅 `file`），无 `line` / `character`；无 rename/format/codeAction。
4. 连接池可实例化（`LspClientPool`）；MCP 自持一份，SIGTERM `disposeAll`。
5. `resolveBin` 为可注入缝；缺省仍解析 iknow `node_modules` + PATH。
6. `--root` > `IKNOW_LSP_ROOT` > cwd；空/非目录启动 fail-fast。
7. MCP 调用 `createSymbolQueryToolSet`（ACI 符号查询工厂，不是 `createLspToolSet`，旧坐标面仅供向后兼容）；不 `registerExternal`。

## Objective

外部编码 agent 经 MCP stdio 对本地项目做符号定位，与 iknow 进程内符号查询（`createSymbolQueryToolSet`）同一套客户端语义。

## Boundaries

- **Does:** `LspClientPool` + `resolveBin`；`src/lsp-mcp/` + bin + README 可复制示例；10 件 read-only 符号查询（进程内 ACI 装配同源）；vitest in-memory + 启动校验。
- **Out of this spec:** 登记仓库 `.iknow/mcp.json`；Cursor plugin；写类 LSP；独立发包；HTTP MCP；Go/Rust server；MCP 写类符号工具（`safe_*` / `replace_*` —— `specs/symbol-primary-aci.md` Out of scope 第 33 行）。

## Success Criteria

1. `npx vitest run tests/lsp-mcp tests/harness/lsp/client.test.ts` EXIT 0。
2. In-memory `tools/list` 恰好 10 件符号查询名（与 `SYMBOL_QUERY_TOOL_NAMES` 一一对齐），且 `readOnlyHint: true`。
3. 非法参数 → tool `isError`，会话可继续。
4. 缺失 `--root` 目录 → stderr 可读、exit ≠ 0、stdout 空。
5. 源码无 `legacy: 'reject'`。
6. 两个 `LspClientPool` 不共享缓存（client 单测）。
7. README 含 `iknow-lsp-mcp` 配置示例；仓库 `.iknow/mcp.json` 无 `iknow-lsp` 条目。

## ACR

```
bounded-context-guardian: yes — 连接池/bin 缝在 src/harness/lsp；MCP 仅 src/lsp-mcp transport；符号查询面来自 src/harness/aci/tools/symbol.ts（SSOT），MCP 在 transport 层只 import `SYMBOL_QUERY_ZOD_SCHEMAS`（SDK 2.0 Standard Schema 强制 Zod），不复制 schema 定义
defensive-contract-validator: yes — empty root；negative 非法 args（缺 query / 缺 file / 缺 symbol_path）；overflow files max 10 继承 ACI；exception 启动 fail-fast + handler isError
error-handling-enforcer: yes — 启动 typed LspMcpRootError；handler catch → isError；dispose 不 kill
complexity-anti-drift: yes — 一池一类 + MCP 薄注册循环；无新 god-file；符号查询工厂复用 cancel/timeout/sentinel 链路
minimal-change-verifier: yes — 本批 1 commit：MCP 装配切换 + TOOL_SCHEMAS 重建 + 测改 + spec 改写（装配缝 / bin / root 解析 / 启动行为均沿用）
```
