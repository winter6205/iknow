# 0092. 文件系统隔离两档；默认全局；会话 tmp 用宿主路径

Date: 2026-09-13
Status: accepted

权限三层（问不问人）与 bash 能碰哪些路径拆成两层。默认 **全局档**：宿主真路径可读可写，拦写靠权限 + hard-wall，home 不藏。可选 **工作区档**：home 可见，写 = 活 `taskRoot` + **会话 tmp**，home 其余默认不能写。会话 tmp 是会话文件夹里每身份一块宿主目录，`$TMPDIR` 指向它，**不** bind 成 Linux `/tmp`。与 `worktreeOnMutate` 正交。规格：`specs/fs-isolation-modes.md`。

**Why not 继续默认闭世界：** 藏 home 逼出垫底与 `/tmp` 两套名字，模型写不到 `~/.iknow` 真路径；操作员要的默认是本机路径 + 权限拦截。

**Why not 工作区档也写整个 home：** 那与全局档无差；工作区档的收紧就是 home 其余不能写（会话 tmp 除外）。

**Why not 卸掉 bwrap：** 沙箱纪律禁止产品路径后台裸跑；网络 / env / rlimit 仍走围栏。本 ADR 只改 FS 姿态与 tmp 命名。

Amends ADR-0037 §9（默认闭世界姿态 superseded；工作区档可复用写白名单）。Amends ADR-0074（寿命与每身份一块保留；bind `/tmp` superseded）。Amends ADR-0068 临时面用词（耐久交付仍 `taskRoot`）。
