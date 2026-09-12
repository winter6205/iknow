# R2 /quit 与 Ctrl+C 对 wait:true 的真实路径

- Map: [主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）](../agent-control-surface-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved (charting research, 2026-09-11)
- Blocked by: —

## Resolution

无选区 Ctrl+C **不总是** abort：要 `running-fg`、非 compacting、无选区、且 `aborters` 有 controller；满足时 signal 经 turn→hub→loop→ACI cancel 进 `waitFor`。`/quit` **不** abort，只 `await inflightPromises`，可等到子代理墙钟。进程首次 SIGINT 的 `shutdown()` **不等** per-task 墙钟（清 timer + SIGTERM + ≤5s）。有选区 Ctrl+C = 复制。证据：`src/tui/app.tsx:1972-1985,2578-2611`；`src/cli/runtime.ts:279-291`；`src/harness/subagent/manager.ts:1477-1524`。

## Question

TUI 前台正在 `spawn_subagent(wait:true)` 时：

1. 按 Ctrl+C（无选区）是否一定 `aborter.abort()`，且该 signal 一定进 `manager.waitFor`？
2. `/quit` 是否会先 abort，还是只 `await inflightPromises`？
3. 第一次进程 SIGINT 的 `shutdown()` 会不会等子代理墙钟？
4. 有选区时 Ctrl+C 复制是否会让操作员以为「打断无效」？

要调用链文件:行。本图不在本票改代码。
