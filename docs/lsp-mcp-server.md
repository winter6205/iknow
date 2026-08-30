# LSP MCP server

`iknow-lsp-mcp` exposes the 10 read-only `lsp_*` tools over stdio using
`@modelcontextprotocol/server` ^2.0.0 (`serveStdio` + `registerTool`).

```json
{
  "mcpServers": {
    "iknow-lsp": {
      "command": "iknow-lsp-mcp",
      "args": ["--root", "/absolute/path/to/your/project"]
    }
  }
}
```

When `--root` is omitted, the server uses `IKNOW_LSP_ROOT`, then `process.cwd()`.
The root must exist and be a directory. Language servers are spawned from the
iknow install's `node_modules` (or PATH). Write tools (rename/format) are not
included.

On SIGTERM/SIGINT the process disposes its LSP connection pool (stdin EOF to
language servers; it never `kill`s them).
