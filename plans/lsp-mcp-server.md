# Plan: LSP MCP server (SDK 2.0)

Tracker: local markdown (worktree `worktree-lsp-optimization`).

## ACR

```
bounded-context-guardian: yes — 连接池/bin 缝在 src/harness/lsp；MCP 仅 src/lsp-mcp transport；不进 ACI registry
defensive-contract-validator: yes — empty root；negative 非法 args；overflow files max 10 继承 ACI；exception 启动 fail-fast + handler isError
error-handling-enforcer: yes — 启动 typed LspMcpRootError；handler catch → isError；dispose 不 kill
complexity-anti-drift: yes — 一池一类 + MCP 薄注册循环；无新 god-file
minimal-change-verifier: yes — 本批 1 commit：池缝 + MCP 壳 + 测 + bin
```

## Tracers

- [implementation] `LspClientPool` + `resolveBin` + `iknow-lsp-mcp` stdio server
  - Inherits: specs/lsp-mcp-server.md；trace-mcp SDK 2.0 形态
  - Surface: `src/harness/lsp`, `src/lsp-mcp`
  - Acceptance: `npx vitest run tests/lsp-mcp tests/harness/lsp/client.test.ts` EXIT 0
