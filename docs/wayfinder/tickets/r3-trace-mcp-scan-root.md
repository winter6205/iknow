# R3 Trace MCP 扫描根与 Cursor 挂载

- Map: [主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）](../agent-control-surface-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved (charting research, 2026-09-11)
- Blocked by: —

## Resolution

Cursor 本会话无 `iknow-trace` namespace → 外部 agent **调不到**三件读工具（形态 A）。即便挂上，仓库 `.iknow/mcp.json` `--trace-out` 是 `/home/winner/.iknow`，TUI 默认写 `<cwd>/.iknow`（`src/tui/run.tsx` → `resolveServeDataDir`）。扫错根时 `list_sessions(limit:1)` **成功**返回错误池最新一条（形态 C，不是 isError）。不新增第四件「最新会话」工具。

## Question

`docs/trace-mcp-server.md` 与仓库 `.iknow/mcp.json` 的 `--trace-out` 指向哪？TUI 默认写侧 data dir 是哪？`list_sessions(limit:1)` 在扫错根时返回什么？Cursor 本会话未挂 `iknow-trace` 时，外部 agent 读「最新会话」会看到什么失败形态（工具不存在 vs 空页 vs 旧会话）？

要对照 ADR-0071 两级树，不提议第四件「最新会话」工具。
