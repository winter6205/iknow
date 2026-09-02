# Trace MCP server

`iknow-trace-mcp` exposes iknow's read-only trace tools over stdio, one per read
axis: `list_sessions` (which sessions exist in a trace directory), `query_trace`
(which records are inside one session, filtered, one page per `limit`), and
`get_record` (the content of one record, read as a character window you address).
Install the package first, then add this entry to the MCP client's `mcp.json`:

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
