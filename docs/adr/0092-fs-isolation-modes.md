# 0092. 文件系统隔离两档；默认全局；会话 tmp 用宿主路径

Date: 2026-09-13
Status: accepted

权限三层（问不问人）与 bash 能碰哪些路径拆成两层。默认 **全局档**：宿主真路径可读可写，拦写靠权限 + hard-wall，home 不藏。可选 **工作区档**：home 可见，写 = 活 `taskRoot` + **会话 tmp**，home 其余默认不能写。会话 tmp 是会话文件夹里每身份一块宿主目录，`$TMPDIR` 指向它，**不** bind 成 Linux `/tmp`。与 `worktreeOnMutate` 正交。

**Why not 继续默认闭世界：** 藏 home 逼出垫底与 `/tmp` 两套名字，模型写不到 `~/.iknow` 真路径；操作员要的默认是本机路径 + 权限拦截。

**Why not 工作区档也写整个 home：** 那与全局档无差；工作区档的收紧就是 home 其余不能写（会话 tmp 除外）。

**Why not 卸掉 bwrap：** 沙箱纪律禁止产品路径后台裸跑；网络 / env / rlimit 仍走围栏。本 ADR 只改 FS 姿态与 tmp 命名。

Amends ADR-0037 §9（默认闭世界姿态 superseded；工作区档可复用写白名单）。Amends ADR-0074（寿命与每身份一块保留；bind `/tmp` superseded）。Amends ADR-0068 临时面用词（耐久交付仍 `taskRoot`）。

## Amendment 2026-09-13 —— 工作区档实施合同（Round 2）

**开关**：`settings.isolation.fsMode`，值域 `"global" | "workspace"`，**只认用户层**（项目文件出现 `isolation` 段即丢弃，ADR-0084 允许名单不含本段）；缺失 / 非法值 / 非字符串 → 按 `"global"` fail-closed（与 `worktreeOnMutate` 同款值域纪律，唯一读取点 `resolveFsIsolationMode`）。运行期经 holder（镜像 `GraphModeContext`）就地翻转，不重建引擎。

**围栏形态**：工作区档在全局档 argv 之上再叠两层（bwrap last-mount-wins 序）——`--bind / /` 打底 → 系统前缀 `--ro-bind` → **`--ro-bind <home> <home>`**（可见但只读）→ `--bind <taskRoot> <taskRoot>` + `--bind <会话 tmp> <会话 tmp>`（两处写白名单覆盖回可写）→ `--proc` / `--dev-bind`。home 是「可见 + 只读」，不是闭世界的「不可见」；home 内两处白名单之外的写路径在内核层 EROFS（退出非零）。home 之外（如 `/tmp`）不受本档收紧——本档只收紧 home 写，不做邻仓身份墙（spec Out of scope）。

**写工具**：`write_file` / `edit_file` 的 containment 根在两种档下**相同**（活 `taskRoot` ∪ 会话 tmp）——工作区档不新增写工具侧拒绝面，收紧只体现在 bash 围栏的 mount 层。两档差异只在 bash 是否可写 home 其余路径。

**Why not 工作区档用 `--ro-bind / /` 打底：** 那会把 `<user>` 下的 `/tmp`、`/etc` 之外的一切也变只读重绑一遍，且 taskRoot / 会话 tmp 白名单要同时在只读面上再 `--bind` 两层；`--bind / /` + `--ro-bind $HOME $HOME` 只需两处覆盖，argv 更短、与全局档 diff 最小。

**Why not 给工作区档加写工具侧 home 黑名单：** 写工具的可写集本来就是 taskRoot ∪ 会话 tmp。工作区档新增的语义是「bash 不能再写 home 其余」，与写工具无差；两处都做等于双实现、两处都可能漂移。
