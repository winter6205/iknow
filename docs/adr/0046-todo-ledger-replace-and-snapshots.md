# 0046. todo 账本可 replace；旧文件留快照；换表不灌 messages

Date: 2026-09-06
Status: accepted

主会话 `todo_write` 是可修订的任务清单，不是 Plan Mode、也不是图上的管线。允许开跑前写一版全局步骤；任务变了用 **replace** 写出新的现行 `todos.md`，旧文件留在同一会话目录当快照。replace 当跳不把新列表追加进 `messages`（tool call 里已有）；后续回合的全局观仍只靠状态栏投影现行未勾项（ADR-0028）。

## Why not

- **Plan Mode 相位**：只读写计划再切执行。否决的是相位，不是「先有一张能改的清单」。
- **同一文件纯追加、旧 `- [ ]` 仍开着**：两套待办并存，全局观碎掉。
- **覆盖并丢掉旧文件**：历史不可查。
- **把 todo 并进 `run_graph`**：默认 chat 的轻规划不该依赖图 overlay。Dynamic Pipeline / replan 另案，挂在图上。
