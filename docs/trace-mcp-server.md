# Trace MCP server

`iknow-trace-mcp` exposes iknow's read-only trace tools over stdio, one per read
axis: `list_sessions` (which sessions exist in a trace directory), `query_trace`
(which records are inside one session, filtered, one page per `limit`/`offset`),
and `get_record` (the content of one record, read as a character window you
address). Install the package first, then add this entry to the MCP client's
`mcp.json`:

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

## Dev / repo-local checkout (no build)

`.iknow/mcp.json` in this repo starts the same server through
`scripts/iknow-trace-mcp-dev.cjs`, which runs `src/trace-mcp/main.ts` via tsx
and resolves both paths relative to itself. The host's cwd does not enter the
equation — launching from any directory under any editor still serves
`tools/list`:

```json
{
  "mcpServers": {
    "iknow-trace": {
      "type": "stdio",
      "command": "node",
      "args": ["scripts/iknow-trace-mcp-dev.cjs", "--trace-out", "trace"]
    }
  }
}
```

This is the same shape `iknow-trace-mcp` (the bin) takes; it is only the entry
mechanism that differs (dev: tsx + repo-relative paths; bin: prebuilt
`dist/trace-mcp/main.js`). When you `npm run build`, the bin becomes the
canonical entry and the dev wrapper can be retired.
