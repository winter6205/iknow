# Trace MCP server

`iknow-trace-mcp` exposes the read-only `query_trace` tool over stdio. Install
the package first, then add this entry to the MCP client's `mcp.json`:

```json
{
  "mcpServers": {
    "iknow-trace": {
      "command": "iknow-trace-mcp",
      "args": ["--trace-out", "/absolute/path/to/your/trace"]
    }
  }
}
```

When `--trace-out` is omitted, the server uses `IKNOW_TRACE_OUT`, then
`./trace/`. The trace directory must already exist when the server starts.
