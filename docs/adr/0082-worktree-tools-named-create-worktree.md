# 0082. 工作树 ACI 注册名去掉 task；先服务 agent 能不能用

Date: 2026-09-10
Status: accepted

模型面五件注册名为 `create-worktree` / `enter-worktree` / `exit-worktree` / `list-worktrees` / `remove-worktree`。description 只回答这把工具做什么、agent 能不能调。写被拦点名是 harness 回执；人喊创建是提示词 + 夹具。旧名 `create-task-worktree` 等不再作模型面名字。磁盘上的 **task worktree** 种类词仍可留在 CONTEXT，不进工具注册名。

**Why not 保留 create-task-worktree：** 名字把「任务」焊进能力面，description 再叠拦截政策，agent 先看到的是流程作文而不是一把建树工具。
