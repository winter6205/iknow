# 0074. 围栏 /tmp 用每身份宿主垫底，跟会话同寿命

Date: 2026-09-09
Status: accepted

闭世界可写集仍是 `taskRoot` + `/tmp`。`/tmp` 不再是一次 bash 一块空 tmpfs：每个身份（主会话或一个 worker）一块会话文件夹内的宿主目录，bind 成该身份围栏的 `/tmp`。`bash` / `write_file` / `edit_file` 都能写这两块根。交差每次带 `task_id` 与该 `/tmp` 根；父用已有 `subagent_result` 按 id 列顶层或读一份。不是交付落点，不自动拷进仓库，不另开 worktree。

**Why not 保持一次命令 tmpfs：** 命令结束即无盘，父无法按路径找到中间物。

**Why not 只让 bash 写 `/tmp`：** 与围栏可写集分裂，写工具比 shell 更窄。

Amends ADR-0068 / ADR-0037 §9.2 的 `/tmp` 寿命句。规格：`specs/parent-visible-tmp.md`。
