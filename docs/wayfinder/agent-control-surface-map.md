# wayfinder:map — 主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）

> Tracker: 本地 markdown（沿用本仓既有 wayfinder 惯例，不开 GitHub issue）
> Charted: 2026-09-11
> 图名（人读引用时用全名）：**主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）**
> 触发会话：`ffff123c-30ce-4a54-b3a2-490864af8739`（TUI 写侧 `iknow/.iknow/projects/iknow-ddcb805367a0/`；用户原话：建树成功但不进去、todo 永远一行、子代理超时、Ctrl+C / 退不出去；另：本 Cursor 会话里 iknow-trace MCP 未挂上）

## Destination

让操作员在一次「多步改代码」会话里，看见并打断一条**可控**的主代理轨迹：建树之后写根与 cwd 一致；todo 能落下一张多步清单而不是被 schema 折成一行；子代理超时/取消对人和对模型都可见；Ctrl+C 与 `/quit` 能结束前台 `wait:true`，而不是卡到墙钟。到达标志是这四条都有**轨迹集或硬闸**可判定，不靠加长 soul / usage。

> 2026-09-11 Confirm。合同：`specs/agent-control-surface.md`；实施序：`plans/agent-control-surface.md`。未实施前不改产品代码。

## Notes

**domain**：模型可见工具面（`todo_write` / worktree 族 / `spawn_subagent`）+ TUI 打断/退出 + Trace MCP 读侧扫描根。原则对齐 `docs/guides/prompt-development.md`：说明书不是闸；能 schema / 轨迹判定的不要只写 prompt；改文案要先有夹具。黄金名册：`todo_write` / `<agent_status>` / 子代理 persona 目前是 **STATIC/SEAM 或缺口**，没有轨迹集。

**每个 session 开工前必读**：

- `arthurpower:logicsync` —— grilling 默认
- `docs/guides/prompt-development.md` —— 动 description / schema / 状态栏必对照
- `arthurpower:domain-modeling` —— 若改 ADR-0037（隔离默认 / 建树=rebind）或 ADR-0046（todo 账本）才走

**本图必须尊重的既有决策**（票内点名挑战者除外）：

- **ADR-0037** —— isolation 默认 OFF；门禁从不 auto-provision；`create-worktree` 成功才 session rebind。`git worktree add` 经 bash **不是** provision 缝。
- **ADR-0046** —— `todo_write` 单工具 + mode；`add` 一条 `item` 字符串；整表替换走 `replace` + `items`。
- **ADR-0014** —— `spawn_subagent` 默认 `wait:true`；墙钟三层链 `def.timeoutMs ?? taskTimeoutMs ?? 7200s`。
- **#146 Q1a** —— TUI `exitOnCtrlC=false`；Ctrl+C 只打断 `running-fg`；退出走 `/quit`。
- **ADR-0071 / trace-mcp v1.1** —— 否决「读最新会话最终结论」第四件工具；动线是 `list_sessions(limit:1) → query_trace`；扫描根必须对准写侧 data dir。

**charting 期核实过的既有事实**（冲突时以该次 trace + 代码为准）：

1. 项目 `.iknow/settings.json`：`isolation.worktreeOnMutate: false`。`create-worktree` 与门禁同开关装配（`build-engine.ts`：「工具在场 ⇔ 门禁已武装」）。本会话 trace **零次** `create-worktree` / `enter-worktree`。
2. 建树实际调用：`bash` `git worktree add -b feat/model-adapter-providers .iknow/worktrees/model-adapter-providers`（09:38:19Z，ok）。树在磁盘上成功；会话 `taskRoot` 仍是主仓。父代理随后用**绝对路径**读写该树，并 `spawn_subagent` 用散文规定子代理 cwd。
3. `todo_write` 第一次：`mode=add`, `item`=**六元字符串数组** → `validation_failed`：`invalid input at /item: must be string`。第二次：`add` 单行「探索 worktree 内 env.ts/settings.ts 完整接口和测试目录」→ ok。现行 `todos.md` 仍只有这一行。模型**已经规划了六步**，被 schema 折成一步。
4. `spawn_subagent`：`wait:true`, **模型自己传 `timeoutMs: 600000`**（10 分钟），`subagent_type=general-purpose`。墙钟 600325ms 后 `tool_kind=ok`（不是 cancelled）。父回合 turn_index 20 被前景阻塞约 10.5 分钟。
5. 超时后父代理自己继续 `edit_file` / `bash` 改同一棵树——操作员看到的「动作不受控制」。
6. TUI：`exitOnCtrlC=false`；Ctrl+C 仅 `canInterrupt === running-fg` 时 `aborter.abort()`；有选区则**复制优先、不打断**。`/quit` **不 abort**，`await Promise.allSettled(inflightPromises)`——前景 `wait:true` 未取消则退出挂起。进程层二次 SIGINT 才 `process.exit(130)`；第一次走 `shutdown()`，仍可能等子进程。
7. `spawn_subagent` 声明 `interruptBehavior: "cancel"` + `timeoutTier: "unbounded"`。设计上 Ctrl+C 应取消 wait；本会话 trace **没有** `cancelled` 的 spawn 记录，故「按了但没断」尚未被本 trace 证伪或证实。
8. 本 Cursor 会话动态工具目录**没有** `iknow-trace`。仓库 `.iknow/mcp.json` 把 `--trace-out` 指到 `/home/winner/.iknow`，而本会话写在 `/home/winner/projects/iknow/.iknow`。对 `~/.iknow` 扫「最新」会落到 2026-09-09 的 consolidation 会话，不是今天这条。这就是「用 MCP 读最新会话报错 / 读错」的第一嫌疑。
9. `grep` 多次 `execution_failed` 且 message 只有 `tool execution failed`（无 kind）——模型改用 bash grep，轨迹更散。
10. `usage` 段只讲符号工具优先级，**不提** todo 首次应用 `replace`、不提 isolation OFF 时不要用裸 `git worktree add` 当 rebind。`git-work` 段只在「`create-worktree` 在场」时要求先调它。

## Decisions so far

- [R1 isolation OFF 时工作树工具是否在场](tickets/r1-isolation-off-worktree-surface.md) — OFF 时 create/enter/list 均不在注册表；裸 git worktree add 不 rebind。
- [R2 /quit 与 Ctrl+C 对 wait:true 的真实路径](tickets/r2-quit-ctrlc-wait-true.md) — `/quit` 只等 inflight 不 abort；有选区 Ctrl+C 复制；进程 SIGINT shutdown ≤5s，不是 2h 墙钟。
- [R3 Trace MCP 扫描根与 Cursor 挂载](tickets/r3-trace-mcp-scan-root.md) — 本会话无 iknow-trace；即便挂上也会扫 `~/.iknow` 而 TUI 写 `<cwd>/.iknow`，`list_sessions` 成功返回错池旧会话。
- [G1 裸 git worktree add 要不要变成 rebind](tickets/g1-bare-git-worktree-rebind.md) — 工具常在、开关只武装写门禁。
- [G4 用户层 vs 共享项目层 settings](tickets/g4-settings-user-vs-project.md) — 两层、无第三层；项目允许名单 + 写回落对层；权限进项目 settings，退役 toml，双文件 fail-loud；规则形态 **amended by** ADR-0090 / `declarative-project-permissions.md`。
- [G2 todo 首次多行：改 schema 还是改回执](tickets/g2-todo-first-write-schema.md) — 目标态：id + 添加/更新/读取；子代理共用父账本；`replace` 降级。跨主会话共用不在本切片。
- [G3 前景 spawn 墙钟与操作员取消](tickets/g3-foreground-spawn-cancel.md) — A：quit/Ctrl+C 能取消 wait；超时非 ok。消息内 running… + dim 最新；概览 Down 聚焦、Ctrl+X 强杀；无 Enter 进详情。

## Not yet specified

- isolation 默认是否要改（超出本图「控制面可判定」也能画完）。
- 父代理超时后是否硬禁止立刻重做同一文件（需先看子代理 envelope 对人/对模型的可见性）。
- `run_graph` 是否应取代「一口 `wait:true` 吃完整 settings 改造」（依赖 spawn 等待契约先清）。
- grep 失败回执吞 kind 是不是独立卫生债（可能毕业成另一张图）。
- 两条主会话是否共用一份 todo 账本（同一 id 跨 conversation 仍有效）。本切片不做；要做须另开 opt-in 列表身份，禁止「同项目所有会话自动共用」。

## Out of scope

- 本图不实现「模型适配器 / 火山方舟 provider」业务（那是触发会话的任务，不是控制面）。
- 不重开「读最新会话第四件 MCP 工具」（spec 已否决）；只问扫描根与客户端是否挂上。
- 不加长 soul 当唯一修复。

## Tickets

票体在 `docs/wayfinder/tickets/`。阻塞用正文 `Blocked by:`。

| 票                                                                                    | 类型     | 问题                                        | 阻塞 |
| ------------------------------------------------------------------------------------- | -------- | ------------------------------------------- | ---- |
| [R1 isolation OFF 时工作树工具是否在场](tickets/r1-isolation-off-worktree-surface.md) | research | 开关 OFF 时模型面有没有 create/enter？      | —    |
| [R2 /quit 与 Ctrl+C 对 wait:true 的真实路径](tickets/r2-quit-ctrlc-wait-true.md)      | research | 前台 spawn 时按键与 /quit 各走到哪          | —    |
| [R3 Trace MCP 扫描根与 Cursor 挂载](tickets/r3-trace-mcp-scan-root.md)                | research | 为何读「最新会话」对不上今天 TUI 会话       | —    |
| [G1 裸 git worktree add 要不要变成 rebind](tickets/g1-bare-git-worktree-rebind.md)    | grilling | isolation OFF 下成功建树后，会话根跟不跟    | R1   |
| [G2 todo 首次多行：改 schema 还是改回执](tickets/g2-todo-first-write-schema.md)       | grilling | add 数组失败后折成一行，闸放哪              | —    |
| [G3 前景 spawn 墙钟与操作员取消](tickets/g3-foreground-spawn-cancel.md)               | grilling | 默认 wait / 模型自填 timeoutMs / 退出谁优先 | R2   |
| [G4 用户层 vs 共享项目层 settings](tickets/g4-settings-user-vs-project.md)            | grilling | 键归属 / 第三层 / 权限家                    | —    |

Frontier（无阻塞、未领取）：空。grilling 已结。地图未清：设置/todo/打断的落地仍待 spec。
