# 0068. hard-wall 相对闭世界的层职责

Date: 2026-09-08

Status: accepted

闭世界围栏（ADR-0037 §9）是 bash 的唯一物理沙箱。hard-wall 只做 spawn 前意图过滤：围栏看不见或拦不住的意图（对可写根的毁灭性 argv、命令替换、敏感路径、fork-bomb）。换行不是危险模式（只作分段符）；`"format"` 不得子串匹配。这取代用语法黑名单模拟沙箱的补丁（含「换行即危险」）。

耐久 mutate（`write_file` / `edit_file`）只落活 `taskRoot`。bash `/tmp` 仍是围栏 tmpfs 进程临时面，不是产品交付落点。子代理与父会话同一写根（ADR-0040），不另开产物目录。`spawn_subagent` 的 `sandboxRoot`：父根下词法包含与越界分家；尚未存在不得报 outside。

**Why not 只放宽换行：** 可写集分裂与错误分类仍在，下一枪仍会误杀。

**Why not 语义 shell AST：** 闭世界已覆盖主机打不穿；AST 是另一扇门，本 ADR 不做。
