# 0037. 可选 worktree 隔离门禁：拦写 → 模型调 ACI 工具建树改绑 → 模型自己再写（默认 OFF）

Date: 2026-08-29

Status: accepted

> Amendments: 2026-08-30 建树职责由 host 自动建树改为模型调用「创建工作树 ACI 工具」；2026-08-31 改绑只切 `taskRoot`（§4 重写）。

> **Amendment 2026-08-30**（issue #836 / 地图 #829）：ON 时门禁**只拦写、不自动 `git worktree add`**——建 task worktree 与会话根改绑由**模型调用「创建工作树 ACI 工具」**完成（成功 = 树在且会话根已切到该路径）；Host 不同波重放被拦的写，被拦的写由模型在新根上自己再调。原文 Decision 1 中「首次 mutate 被拦截 → host `git worktree add` 建树改绑」的读法 **superseded**。同批修订：说明书（rules）改为按需读——父会话不整段灌 rules、缺目录视为空，见 ADR-0009 D2 的 amended 说明与 `docs/CONTEXT.md` 术语「说明书读法」。
> **Amendment 2026-08-30（工具面扩展，issue #839 / 地图 #829）**：enter/exit 对称工具——`enter-task-worktree` **显式进入**一棵本仓已存在的 task worktree（含他人树；授权锚 = 持久化的 `session.workspaceRoot`，只由工具成功 + 会话保存写成外来树，故是天然的显式进入持久记录；provision 据此 adoption 放行该会话在其上的 mutate），`exit-task-worktree` **回到主仓根**（主仓根由树经 git common dir 派生，重启安全）；exit **树保留不删**（孤儿树自动删除仍是明确非目标）。门禁本体不变。

## Context

ADR-0023 裁决 4 曾锁定「v1 = 单根 + recents + 三锚合一；worktree/多根只读推迟」。当时推迟的对象是 **product workspace 多根**（serve 主根的多个绑定），而不是多会话共写同一目录的物理隔离问题。操作员后来提出的诉求是另一件事：多个会话（或会话与人在同一检出目录）并行改动会互相踩踏——解法是 git worktree，不是给 serve 再开几个主根。本 ADR 因此 **reopen ADR-0023 推迟面中一个窄例外**：会话级 git worktree 隔离，由全局开关控制、默认关闭；ADR-0023 的 serve 单根 + recents + 三锚合一语义原样保留，不被本 ADR 覆盖或静默修改。

边界先钉死：**git worktree ≠ product workspace 多根**。worktree 是 git 层的物理检出，服务「隔离写冲突」这一个目的；`workspace` / `workspaceRoot`（ADR-0019 / ADR-0023）是产品层的主根与 per-root 状态锚语义，本 ADR 不移动它们。

## Decision

新增全局开关 `settings.isolation.worktreeOnMutate`（boolean-only，**默认 OFF**；缺失或非 `true` 一律按 OFF，与 `settings.memory.autoExtract` 同款 fail-closed 值域纪律）。精确的字段接线与类型落点由实施 bullet 落在 `src/config`，本 ADR 锁的是语义合同。

### 1. 开关两态（硬要求 1）

- **OFF（默认）**：会话行为与今日完全一致——读、写、permission、目录全部现状，不新增任何拦截点。
- **ON**：会话可**只读**主仓（read / grep / glob / 只读 bash 等读路径放行，可留在主仓；项目相对读路径不改写到主仓绝对路径）。一旦出现**写路径**（write_file / edit_file / 会改工作区的 bash 等 mutate），门禁把该写**拦住**——host **不自动** `git worktree add`，而是由**模型调用「创建工作树 ACI 工具」**完成建 task worktree（含 task 分支）与**当前会话**根锚改绑；工具成功 = 树已在且会话根已切到该路径，此后本会话 mutate 只进该根。工具成功后 Host 只保证路径已切：**不同波重放**被拦的写、不偷偷代执行，被拦的写由模型在下一回合于新根上**自己再调**；也不要求操作员 `/continue`。已绑定本会话 task worktree 时写路径直接放行，不建第二棵树。

### 2. 改绑只影响本会话（硬要求 2–5）

创建 worktree 必须改绑本会话——只建树不绑定 = 不合格。改绑不 checkout 其它会话 / 其它 worktree 的 HEAD；在 task worktree 内 push / 开 PR 不得拖动主仓或其它 worktree 的当前分支。主仓并行共写不是目标形态：本功能是**可选隔离**，不是替操作员猜「是否开任务」。子代理 spawn 自父会话，跟随父会话改绑后的同一棵树，不触发第二棵树（装配面由实施 bullet 落实）。

### 3. task worktree / task 分支名已存在时的确定性策略（硬要求 8）

按 fail-closed 处理：创建工作树 ACI 工具向模型返回**可见 typed 错误，不静默覆盖、不复用归属不明的树、不 checkout 其它会话的 HEAD**。同会话内的并发首次 mutate（硬要求 7）不在此列——建树幂等，多条写路径在建树完成前同时到达也只产生一个 worktree / 一个 task 分支，不双写主仓。

### 4. 会话根按角色分工：改绑只切 `taskRoot`（与 ADR-0019 / ADR-0023 的关系）

> **Amendment 2026-08-31**（issue #855 / 地图 #829，`plans/worktree-session-roots.md`）：本节原文把「本会话生效的根锚」写成 `cwd` / `workspaceRoot` **一并**切到 task worktree，等于让 ADR-0019 的 per-root 状态锚与写隔离根撞在同一字段上——改绑后记忆库、tasks 登记、settings、说明书、permissions、项目 skills 全部跟着搬到 gitignored 的空树上。该读法 **superseded**：改绑只切 `taskRoot`。

会话按**角色**持四个根，互不兼任（`productRoot` / `taskRoot` / `installRoot` 是会话根，`projectIdentityRoot` 是项目根 —— 改绑不动它）：

- **`productRoot`** — 开会话时的主 checkout，首次装配钉死，跨 rebind 与进程重启不变（重启时可由 task 树的 git common dir 派生，与 exit 工具同源）。`mcp.json` 只问它（`mcpConfigRoot` 由它派生，ADR-0037 amendment 2026-08-30 已落地，保持不变）。**项目身份**（rules / 项目 `AGENTS.md` / `permissions.toml` / 项目 skills 发现、子代理继承的身份根、记忆库命名空间名）不问 `productRoot` 而问 **`projectIdentityRoot`** —— 用户此刻在做的那个项目，宿主启动时钉一次（今日 = 启动 cwd），跨改绑不动，缺席时退 cwd（hub 的 per-root 重建多一级中间回退：钉下的值 → 当前 `boundRoot` → `root`）。装配层对**钉下的值与回退值一律套 `mainCheckoutOf`** —— 身份根不得是 task worktree：exit 后树保留不删，操作员可能在遗留树里启动，只归一化回退会让「钉了」比「没钉」更差（钉住空树 = 项目 rules / `AGENTS.md` / skills 全部消失，review round 4 实测）；取值在装配层定，**校验走会话根 SSOT**（`resolveSessionRoots` 的第四个角色，空 / 相对值 typed fail-closed，绝不按 `process.cwd()` 解释）。两者必须分开：宿主按 ADR-0019 把 `productRoot` 取自 `workspaceRoot`，而 `--workspace-root <dir>` 重定向档下 `<dir>` 不是项目（`dir ≠ cwd`），拿它查身份会让项目自己的说明书 / rules / skills 静默消失（amendment 2026-08-31 review round 2 实测）。**per-root 状态**（记忆库落盘根 / tasks 登记）的锚是 `workspaceRoot`，但改绑后 `workspaceRoot` 自身已是树，此时退到 `productRoot`——因此 ADR-0019 D1.3 的 `--workspace-root <dir>` 重定向仍生效，而状态永不落进 gitignored 的树。记忆库的**命名空间名**由 `projectIdentityRoot` 决定，不由 `taskRoot` 也不由锚决定：同一锚下多个项目不得塌进同一命名空间。settings 的读 / watch / 写回锚在**启动时**解析的根，改绑不重载（见 §5），因此也不跟 `taskRoot`。
- **`taskRoot`** — 本会话 task worktree（create / enter 切过去，exit 切回主仓）。**写与工具 cwd 只问它**：`write_file` / `edit_file` / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录。
- **`installRoot`** — iknow 运行时自身的安装位置（worker bootstrap 解析 tsx 与自身依赖）。**≠ 用户项目的 `node_modules`**，因此裸 task worktree 上真 worker 仍能起。

ADR-0019 D1.1 的默认解析（`workspaceRoot` 默认 `process.cwd()`）与 serve 主根（ADR-0023，显式选定 + unbound 语义）都不变——改绑不是 serve 主根重绑，不触碰 recents / trust，也不是把 git worktree 提升为 product workspace 多根。主仓检出保持只读原位。

配套硬约束：

- 改绑成功**不复制、不 seed** 主仓 `.iknow/{rules,skills,memory,sessions,tasks}` 到树上；树上缺目录视为空，项目身份仍读 `projectIdentityRoot` 上的现有文件。
- 调用方禁止用 `join(cwd, '.iknow', …)` 或 `join(workspaceRoot, '.iknow', …)` 充当项目身份；一律经会话根 SSOT 按角色取路径，缺根 / 相对路径 fail-closed，**不回退 `process.cwd()`**。
- **父会话引擎**的工具 sandbox 在**隔离开关 ON 且已改绑时**（`isolationEnabled` 且 `taskRoot` 是 task worktree）对 `projectIdentityRoot` 放**只读**行（与 §1「读路径可留在主仓」同源；实现上是身份根整棵树的读放行 —— 它可能是主 checkout 的**子目录**，不是逐条身份路径白名单）；写仍不得进主仓。这条放行是本次改动新增的，OFF 档「今日」是**一条都不给**，所以门必须同时看开关：`taskWorktreeOwnerOf` 只是路径形状判断，单靠它会让一个恰好长成 `<X>/.iknow/worktrees/<name>` 的 cwd 在隔离关闭时拿到沙箱外的读放行（amendment 2026-08-31 review round 3/4 实测）。已知缺口（记在 `plans/worktree-session-roots.md` 的 follow-up 段，尚未开 issue）：只 `read_file` 拿到这条放行，`grep` / `glob` 仍限在 `taskRoot`；子代理 worker 的 registry 也没拿到（worker 的说明书是灌进去的，不靠读）。
- 用户级 `~/.iknow`（画像、用户 rules / `AGENTS.md`、`init.sh`、trust）继续跟 `home`，既不跟 `productRoot` 也不跟 `taskRoot`。

### 5. 配置读取合同（硬要求 9）

开关只在**启动加载点**读取一次；config 层只承载 boolean 值域语义——**不读 git、不持会话状态**。会话根改绑**不隐式重载** project settings：settings 来源在会话生命周期内保持启动时的装配结果；如未来需要「改绑后重载 settings」语义，必须显式另立决定，不允许静默切换 settings 来源。

### 6. 失败语义 fail-closed（硬要求 6）

主仓不是 git 仓库 / git 不可用 / 创建工作树 ACI 工具失败（`git worktree add` 或改绑失败）：mutate 一律被拦下并给出**typed、非空、可见**的错误（对齐 harness fault-class 与 session-api `WorkspaceRootError` 的类型化错误惯例），**不静默放行写主仓**——建树/绑定失败后的主仓零写入是验收项，不是隐含假设。开关本身缺失或非法回落 OFF，即回落至今日行为，同一 fail-closed 来源。

## Consequences

### Positive

- 多会话并行不再互踩：ON 时首个 mutate 后会话获得物理隔离的写目录，主仓保持只读。
- 默认 OFF 保证零回归路径；操作员显式 opt-in 才改变行为。
- git worktree ≠ workspace 多根的边界写死，避免把本开关与 serve 主根 / `workspaceRoot` 语义搅在一起。

### Negative / Trade-offs

- ON 时首次 mutate 引入建树成本与会话根切换，操作员需要能看出当前绑在哪棵树上（展示面由实施 bullet 落实）。
- 同名 task worktree / 分支已存在时 fail-closed 报错——残留的孤儿树需要人工清理后才可继续同名任务。
- 「提交 → push → PR」的产品向导与 GitHub / `gh` 鉴权不在本 ADR 范围，另轨处理。

### Reversibility

- 开关 OFF 即完整还原今日行为；已建的 task worktree 是独立目录，删除即回收，不影响主仓与其它 worktree。

## Evidence

- `plans/worktree-isolation-on-mutate.md` ACR 5/5 PASS（2026-08-29；bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier 全 yes）。
- `plans/worktree-isolation-model-provision.md` ACR 5/5 PASS（2026-08-30）——amendment 来源（issue #836，地图 #829）。
- 实施证据由后续 bullets（settings 面 → mutate 门禁 + 改绑 → passthrough → 操作员可见状态）各单 commit 提供，本 ADR 为 decision record，不含运行时代码。
