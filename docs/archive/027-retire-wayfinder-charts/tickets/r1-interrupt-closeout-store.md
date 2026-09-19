# R1 closeout 与权威历史丢掉什么

- Map: [打断后本轮去哪了](../interrupt-round-visibility-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved (charting research, 2026-09-19)
- Blocked by: —

## Resolution

cancelled **不丢本轮 user**。所谓「整回合不进历史」= **不 append 未完成的 assistant**。两相位都 append `Interrupted by user.`。RAM 与 cancelled 落盘（`full`）对齐。

- **模型在途**：`messages` = user + system interrupt。assistant 不进史（`loop-engine.ts` `modelStop`/`finalState: opts.state`；`appendSystemInterrupt` 950, 954–964, 3024–3031, 3040–3047）。测试：`loop-engine.test.ts:1168-1209`；`chat-session-checkpoint.test.ts:559-583`；hub 盘 `hub.test.ts:536-573`。
- **工具在途**：user + assistant + cancelled `tool_result` + system interrupt（S13 `loop-engine.test.ts:1253-1309`、`1435-1465`；executor `buildFailureResult` `tools/executor.ts:288-291`）。Hub 无单独「工具在途 Esc」e2e，盘面由 engine 形状 + `checkpoint.ts:121-124` `full` 推出。
- vs **user-turn keep on protocol failure**：protocolError 也 keep user、drop assistant，但走 `partial_user_only` 且 **不加** interrupt。

CONTEXT「整回合不进历史」易读成连 user 一起丢；代码不是那样。

## Question

Esc **前台打断** 命中 Loop Engine 之后，权威历史（session-api messages，以及落盘 transcript）实际丢掉什么？

必须分开两条相位，都要 `file:line`（实现 + 锁行为的测试）：

1. **模型在途**（尚无已 append 的本轮 assistant）：本轮 user 还在不在？整回合不进历史是否含 user？会不会仍 append **interrupt system message**？
2. **工具在途**（assistant 已 append）：assistant / 部分 tool_result / `Interrupted by user.` 各在不在？

对照 `docs/CONTEXT.md` 的 **in-flight closeout** 与 **user-turn keep on protocol failure**：cancelled 路径是否真的「整回合不进历史」，还是只丢掉未完成的 assistant。不要只复述 CONTEXT。

本票不裁定该不该看得见，不读 TUI 渲染（那是 R2）。
