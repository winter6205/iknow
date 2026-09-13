# Trace MCP server

`iknow-trace-mcp` exposes iknow's read-only trace tools over stdio, one per read
axis: `list_sessions` (which session folders exist under the scan root),
`query_trace` (which records are inside one session, filtered, one page per
`limit`/`offset`), and `get_record` (the content of one record, read as a
character window you address).

`--trace-out` / `IKNOW_TRACE_OUT` is the **scan root**, not a flat `*.jsonl`
directory. After ADR-0071 the product write side is the two-level tree
`<scanRoot>/projects/<slug>/<conversationId>/trace.jsonl`. Point the flag at
the serve data dir the writer actually uses: the session pool is `~/.iknow`
(or an explicit `--data-dir` / `--trace-out`). `workspaceRoot` does not shard
transcripts (ADR-0087). Match the flag to that pool, or the scan finds nothing.

When the flag and env are both omitted, the stdio process still falls back to
`./trace/` (legacy wire for old checkouts). That path is **not** where new
sessions land; pass an explicit scan root.

The scan root must already exist when the server starts.

Install the package first, then add this entry to the MCP client's `mcp.json`:

```json
{
  "mcpServers": {
    "iknow-trace": {
      "command": "iknow-trace-mcp",
      "args": ["--trace-out", "/absolute/path/to/.iknow"]
    }
  }
}
```

## Dev / repo-local checkout (no build)

`.iknow/mcp.json` in this repo starts the same server through
`scripts/iknow-trace-mcp-dev.cjs`, which runs `src/trace-mcp/main.ts` via tsx.
Edit `--trace-out` to your serve data dir (absolute path; `~` is not expanded).

```json
{
  "mcpServers": {
    "iknow-trace": {
      "type": "stdio",
      "command": "node",
      "args": [
        "scripts/iknow-trace-mcp-dev.cjs",
        "--trace-out",
        "/absolute/path/to/.iknow"
      ]
    }
  }
}
```

This is the same shape `iknow-trace-mcp` (the bin) takes; it is only the entry
mechanism that differs (dev: tsx + repo-relative launcher; bin: prebuilt
`dist/trace-mcp/main.js`). When you `npm run build`, the bin becomes the
canonical entry and the dev wrapper can be retired.

`dist/` is gitignored and absent from a fresh checkout, so the two startup
tests that exercise the built entry (`tests/trace-mcp/startup.test.ts`: the bin
symlink and the `dist/trace-mcp/main.js` symlink) need it to exist. `npm test`
builds it once via `pretest`; when you run `npx vitest run <file>` directly,
run `npm run build` first. Without the artifact those two cases skip with a
visible reason instead of failing — the other cases in the file are
dist-independent and always run.
