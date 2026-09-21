# 0096. `/config` 升为设置面板；FS / worktree 门禁 / 子代理并发上限同屏

Date: 2026-09-15
Status: accepted

TUI 无参 `/config` 打开与 `/model` 同族的浮层面板（↑↓ 选行、Enter 改值、Esc 保存退出并落盘用户层 settings），不再只靠命令行参数翻文件系统隔离档。首版三行：文件系统隔离档（全局 / 工作区）、worktree isolation mode（ON/OFF）、子代理并发上限预设 `3 | 5 | 9 | 15 | unlimited`。有参 `/config …` 仍留给 chat/serve 与脚本，语义与面板同一 holder + 同一持久化。后续设置只加行，不加新 slash。规格后续 `specs/` 承接，本 ADR 只锁形状与上限告知策略。

**Why not 每个开关一个 slash：** `/config` 已占词表；再加 `/isolation` `/subagent-cap` 会把词表和面板族打散，和 `/model` 已证明的「一词表入口 + 一块面板」相反。

**Why not 把并发上限写进 system 前缀：** 前缀要稳；上限会在面板里改。常驻 system 要么过期要么每改一次抖缓存。闸是 manager 硬顶；模型侧靠两处现势——`spawn_subagent` 工具 description 插入当前上限，以及超限时 `SubAgentCapacityError` 回 tool_result（已含 `active/max`）。人看面板与 `/info`。不在会话开头另灌一段「当前上限 N」。

**Why not 超限才告诉模型、description 里不写 N：** 模型在打出第 N+1 张之前需要规划并行度；description 里的 N 与错误回执必须同一数字。超限回执保留，不是唯一告知通道。

**Why not 去掉硬顶（只靠「unlimited」一种）：** 无帽会把本机进程与上下文打满。`unlimited` 是预设之一：manager 不做并发拒绝，OS / 内存仍是事实顶。默认仍 15。

Amends ADR-0092（TUI `/config` 入口从「参数翻 FS 档」扩成面板；FS 两档值域不变）。Amends ADR-0037（`worktreeOnMutate` 可在会话内由面板翻转并落盘，不改变门禁从不 auto-provision）。Amends ADR-0014（上限可在运行中经同一 manager 顶调整；图节点仍计入同一顶；`unlimited` 视为该顶不拒绝）。
