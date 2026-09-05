# 0037. 可选 worktree 隔离门禁：模型调 ACI 工具建树改绑 + 活 taskRoot（默认 OFF）

Date: 2026-08-29

Status: accepted

> **Amendment 2026-09-04**（`specs/casual-ask-context-hygiene.md`）：§1「读放行、写才拦」不变。bash 是否 mutate **不得**复用 `validateReadonlyCommand`（那是 bash readonly **模式**的 deny-by-default 表，`2>&1` 也拒）。门禁自备「会不会写工作区」判定；`2>&1` / 管道 / 只读命令串为读。`validateReadonlyCommand` 不为本门禁放宽。`unboundMutateNotice` 仍点名 `create-task-worktree`、仍不 auto-provision；文案改为事实阻断（这次调用会写主仓、未执行；若要写则调工具再重试这一次），不得把模型下一拍收成「去建树」。不按用户问句分型。不改 `create-task-worktree` ACI 形状。

> Amendments: 2026-08-30 建树职责由 host 自动建树改为模型调用「创建工作树 ACI 工具」；2026-08-31 改绑只切 `taskRoot`（§4 重写）；2026-09-02 reopen——model-provision 契约 + 活 `taskRoot`（§7 新增）+ 撤销「same-turn mutator 列为非目标」（§8 显式撤销）；2026-09-05 bash 围栏身份根 ro-bind overlay + 模型可见写根（issue #891）。

> **Amendment 2026-08-30**（issue #836 / 地图 #829）：ON 时门禁**只拦写、不自动 `git worktree add`**——建 task worktree 与会话根改绑由**模型调用「创建工作树 ACI 工具」**完成（成功 = 树在且会话根已切到该路径）；Host 不同波重放被拦的写，被拦的写由模型在新根上自己再调。原文 Decision 1 中「首次 mutate 被拦截 → host `git worktree add` 建树改绑」的读法 **superseded**。同批修订：说明书（rules）改为按需读——父会话不整段灌 rules、缺目录视为空，见 ADR-0009 D2 的 amended 说明与 `docs/CONTEXT.md` 术语「说明书读法」。
>
> **Amendment 2026-08-30（工具面扩展，issue #839 / 地图 #829）**：enter/exit 对称工具——`enter-task-worktree` **显式进入**一棵本仓已存在的 task worktree（含他人树；授权锚 = 持久化的 `session.workspaceRoot`，只由工具成功 + 会话保存写成外来树，故是天然的显式进入持久记录；provision 据此 adoption 放行该会话在其上的 mutate），`exit-task-worktree` **回到主仓根**（主仓根由树经 git common dir 派生，重启安全）；exit **树保留不删**（孤儿树自动删除仍是明确非目标）。门禁本体不变。
>
> **Amendment 2026-08-31**（issue #855 / 地图 #829，`plans/worktree-session-roots.md`）：本节原文把「本会话生效的根锚」写成 `cwd` / `workspaceRoot` **一并**切到 task worktree，等于让 ADR-0019 的 per-root 状态锚与写隔离根撞在同一字段上——改绑后记忆库、tasks 登记、settings、说明书、permissions、项目 skills 全部跟着搬到 gitignored 的空树上。该读法 **superseded**：改绑只切 `taskRoot`。
>
> **Reopen 2026-09-02**（issue / 地图未定，`plans/worktree-live-task-root.md`）：原文 §1 描述的「首次 mutate 自动 `git worktree add` 建树改绑」（auto-provision）与已 shipped 的 model-provision 实现不符——`src/harness/isolation/worktree-gate.ts` 注释明写「NEVER provisions（no `git worktree add` on the execution path）」，建树职责完全落在「创建工作树 ACI 工具」上；门禁在「会写但还没建过树」这一中间态下只是一句「未绑定 → 请模型调工具」的可观察阻拦。同时，旧裁决隐含的「同 run 内 mutate 在工具成功后必须由操作员 `/continue` 触发」与 trace 实测直接冲突：拒绝会让用户放弃。本 reopen 三件事：(a) 在 §1 写齐 model-provision 契约；(b) 在 §7 新增活 `taskRoot` 决定（唯一 writer / batch 快照 / 稳定根清单 / rebind 生效边界）；(c) 在 §8 显式撤销「same-turn mutator 列为非目标」并写明撤销理由 = §1 的 trace 证据 + spec 原文「也不要求操作员 `/continue`」（被 `4b4fa6fe` 撤销的修订版原文）。

> **Accepted amendment 2026-09-03**（issue #869 / `specs/task-worktree-lifecycle.md`）：§3 的任务树叶子现在允许可选的合法 kebab label，形状为 `<label>--<conversationId>`；省略或非法 label 继续使用历史 `<conversationId>` 叶子，历史树不迁移。`taskWorktreeOwnerOf` 始终从最后一个 `--` 后的 conversationId 反演，label 只用于展示与按 label 定位，绝不参与归属裁决；任务分支在带 label 时采用 `iknow/task/<label>-<uuid8>`，碰撞仍 fail-closed。新增条件化、append-only 的 `list-task-worktrees`（只读）与 `remove-task-worktree`（显式回收）工具面，host 缝缺席时不注册；回收默认不删分支，脏树、未确认推送的独占提交和当前根均拒绝。建树后的可选 `.iknow/worktreeinclude` 只镜像匹配且已被 gitignore 的文件，且身份根只读通道扩展到 `grep` / `glob`；门禁、活 taskRoot、生效批边界、exit 保留树和 worker 所有权约束均不变。补记本次 reopen §3 的理由与取舍：叶子名兼职身份与展示的旧形状让人与模型都无法认树，label 因此只承接展示与定位，身份仍是 conversationId 后缀，`taskWorktreeOwnerOf` 的归属裁决逐字不变。代价是叶子反演从「整段叶子 = id」变为「取最后一个 `--` 之后的后缀」；选择纯路径反演而非登记表，因为零登记表 = 零新增状态，历史无 `--` 叶子天然兼容、无需迁移。依据见 `specs/task-worktree-lifecycle.md`（命名合同条款 1–5 与 SC1/SC6/SC9）。

> **Amendment 2026-09-05**（issue #891 / `plans/891-taskroot-remaining-consumers.md`）：§4「写仍不得进主仓」落到 bash 物理围栏。实测（2026-09-05 复现脚本）：改绑后 bash 围栏的 `--bind $HOME $HOME` **后挂**于 cwd bind（`bindArgs` 非 `cwdReadonly` 分支），主仓在 home 下时被这个可写祖先罩住，`mkdir -p <主仓>/…` 穿透成功（exit 0）。修复不是新增第五根——写根仍是 `SessionRoots.taskRoot`，围栏只把 `projectIdentityRoot` 整棵树以 `--ro-bind` **后挂**在 writable home bind 之后（同一覆盖祖先纪律，`cwdReadonly` 已证明）：
>
> (a) **overlay 条件** = 隔离开关 ON 且活 `taskRoot` 已改绑（`taskWorktreeOwnerOf(taskRoot)` 有主）。未改绑时 cwd 就是主仓，mutate 由门禁拦，围栏 argv 不变。
> (b) **argv 顺序** = 身份根 `--ro-bind` 必须出现在 writable home `--bind` **之后**（bwrap 后挂子挂载覆盖祖先）；其它 token 逐字节不变。
> (c) **fail-loud** = 身份根空白 / 盘上不存在时抛 typed 可见错误、**不 spawn**；禁止 `existsSync` 静默跳过（与 `optionalHostRoBindArgs` 的存在性跳过不同轴：身份根是合同输入，缺席是配置故障，不是可选主机前缀）。
> (d) **OFF / 未改绑** = 不传 overlay 选项，`createBwrapFence` argv 与今日逐字节一致（`verify/sandbox-run.ts` 本轮不传）。
> (e) **模型可见面** = 改绑后模型（含子代理）经 worker prior messages / path-outside 回执看见当前写根 = 活 `taskRoot`；system `## Project path` 仍钉 `projectIdentityRoot`（`projectPathSegment` 字节不动），不静默改写 spawn `task` 正文。前台（`bash.ts`）与后台（`defaultBackgroundSpawn`）必须消费**同一** overlay token（CONTEXT 沙箱纪律：前后台共用围栏）。

## Context

ADR-0023 裁决 4 曾锁定「v1 = 单根 + recents + 三锚合一；worktree/多根只读推迟」。当时推迟的对象是 **product workspace 多根**（serve 主根的多个绑定），而不是多会话共写同一目录的物理隔离问题。操作员后来提出的诉求是另一件事：多个会话（或会话与人在同一检出目录）并行改动会互相踩踏——解法是 git worktree，不是给 serve 再开几个主根。本 ADR 因此 **reopen ADR-0023 推迟面中一个窄例外**：会话级 git worktree 隔离，由全局开关控制、默认关闭；ADR-0023 的 serve 单根 + recents + 三锚合一语义原样保留，不被本 ADR 覆盖或静默修改。

边界先钉死：**git worktree ≠ product workspace 多根**。worktree 是 git 层的物理检出，服务「隔离写冲突」这一个目的；`workspace` / `workspaceRoot`（ADR-0019 / ADR-0023）是产品层的主根与 per-root 状态锚语义，本 ADR 不移动它们。

2026-09-02 reopen 的具体背景：本 ADR 原文 §1 把「拦下首次 mutate → host `git worktree add` 建 task worktree → 改绑当前会话根锚」描述为门禁侧的自动动作。该描述与已 shipped 的实现不符——`src/harness/isolation/worktree-gate.ts` 注释明写「NEVER provisions（no `git worktree add` on the execution path）」，建树职责完全落在「创建工作树 ACI 工具」上；门禁在「会写但还没建过树」这一中间态下只是一句「未绑定 → 请模型调工具」的可观察阻拦。同时，「同 run 内 mutate 在工具成功后必须落到新树」这条事实语义，与「same-turn mutator 列为非目标」的旧裁决直接冲突：trace 实测显示拒绝会让用户放弃。本 ADR 因此补齐 model-provision 契约、把 `taskRoot` 做成活根并显式撤销那条旧裁决。

## Decision

新增全局开关 `settings.isolation.worktreeOnMutate`（boolean-only，**默认 OFF**；缺失或非 `true` 一律按 OFF，与 `settings.memory.autoExtract` 同款 fail-closed 值域纪律）。精确的字段接线与类型落点由实施 bullet 落在 `src/config`（唯一 fail-closed 读取点见 `src/config/settings.ts:236`），本 ADR 锁的是语义合同。

### 1. 开关两态（硬要求 1）

- **OFF（默认）**：会话行为与今日完全一致——读、写、permission、目录全部现状，不新增任何拦截点。
- **ON**：会话可**只读**主仓（read / grep / glob / 只读 bash 等读路径放行，可留在主仓）；一旦出现**写路径**（write_file / edit_file / 会改工作区的 bash 等 mutate），门禁把该写**拦住**——host **不自动** `git worktree add`，而是由**模型调用「创建工作树 ACI 工具」**完成建 task worktree（含 task 分支）与**当前会话**根锚改绑；工具成功 = 树已在且会话根已切到该路径，此后本会话 mutate 只进该根。已绑定本会话 task worktree 时写路径直接放行，不建第二棵树。

### 2. 改绑只影响本会话（硬要求 2–5）

创建 worktree 必须改绑本会话——只建树不绑定 = 不合格。改绑不 checkout 其它会话 / 其它 worktree 的 HEAD；在 task worktree 内 push / 开 PR 不得拖动主仓或其它 worktree 的当前分支。主仓并行共写不是目标形态：本功能是**可选隔离**，不是替操作员猜「是否开任务」。子代理 spawn 自父会话，跟随父会话改绑后的同一棵树，不触发第二棵树（根归属语义由 ADR-0040 收窄并发落）。

### 3. task worktree / task 分支名已存在时的确定性策略（硬要求 8）

按 fail-closed 处理：创建工作树 ACI 工具向模型返回**可见 typed 错误，不静默覆盖、不复用归属不明的树、不 checkout 其它会话的 HEAD**。同会话内的并发首次 mutate（硬要求 7）不在此列——建树幂等，多条写路径在建树完成前同时到达也只产生一个 worktree / 一个 task 分支，不双写主仓。

### 4. 会话根按角色分工：改绑只切 `taskRoot`（与 ADR-0019 / ADR-0023 的关系）

本节原文 2026-08-31 已由 amendment 锁定「改绑只切 `taskRoot`，不动 ADR-0019 的 per-root 状态锚」；2026-09-02 reopen 在此基础上把 `taskRoot` 从装配期冻结字段升级为**活根**——其活性边界见第 7 节。

会话按**角色**持四个根，互不兼任（`productRoot` / `taskRoot` / `installRoot` 是会话根，`projectIdentityRoot` 是项目根 —— 改绑不动它）：

- **`productRoot`** — 开会话时的主 checkout，首次装配钉死，跨 rebind 与进程重启不变（重启时可由 task 树的 git common dir 派生）。`mcpConfigRoot` 只问它，由它派生。**项目身份**（rules / 项目 `AGENTS.md` / `permissions.toml` / 项目 skills 发现、子代理继承的身份根、记忆库命名空间名）不问 `productRoot` 而问 **`projectIdentityRoot`** —— 用户此刻在做的那个项目，宿主启动时钉一次（今日 = 启动 cwd），跨改绑不动，缺席时退 cwd（hub 的 per-root 重建多一级中间回退：钉下的值 → 当前 `boundRoot` → `root`）。装配层对**钉下的值与回退值一律套 `mainCheckoutOf`** —— 身份根不得是 task worktree。取值在装配层定，**校验走会话根 SSOT**（`resolveSessionRoots` 的第四个角色，空 / 相对值 typed fail-closed，绝不按 `process.cwd()` 解释）。`--workspace-root <dir>` 重定向档下 `<dir>` 不是项目（`dir ≠ cwd`），拿它查身份会让项目自己的说明书 / rules / skills 静默消失。**per-root 状态**（记忆库落盘根 / tasks 登记）的锚是 `workspaceRoot`，但改绑后 `workspaceRoot` 自身已是树，此时退到 `productRoot`——因此 ADR-0019 D1.3 的 `--workspace-root <dir>` 重定向仍生效，而状态永不落进 gitignored 的树。记忆库的**命名空间名**由 `projectIdentityRoot` 决定，不由 `taskRoot` 也不由锚决定：同一锚下多个项目不得塌进同一命名空间。settings 的读 / watch / 写回锚在**启动时**解析的根，改绑不重载（见 §5），因此也不跟 `taskRoot`。
- **`taskRoot`** — 本会话 task worktree（create / enter 切过去，exit 切回主仓）。**写与工具 cwd 只问它**：`write_file` / `edit_file` / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录。`taskRoot` 的活性见第 7 节——它是本 ADR 2026-09-02 reopen 的核心新增，决定与 SSOT 见 `src/harness/session-roots.ts`。
- **`installRoot`** — iknow 运行时自身的安装位置（worker bootstrap 解析 tsx 与自身依赖）。**≠ 用户项目的 `node_modules`**，因此裸 task worktree 上真 worker 仍能起。

ADR-0019 D1.1 的默认解析（`workspaceRoot` 默认 `process.cwd()`）与 serve 主根（ADR-0023，显式选定 + unbound 语义）都不变——改绑不是 serve 主根重绑，不触碰 recents / trust，也不是把 git worktree 提升为 product workspace 多根。主仓检出保持只读原位。

配套硬约束：

- 改绑成功**不复制、不 seed** 主仓 `.iknow/{rules,skills,memory,sessions,tasks}` 到树上；树上缺目录视为空，项目身份仍读 `projectIdentityRoot` 上的现有文件。
- 调用方禁止用 `join(cwd, '.iknow', …)` 或 `join(workspaceRoot, '.iknow', …)` 充当项目身份；一律经会话根 SSOT 按角色取路径，缺根 / 相对路径 fail-closed，**不回退 `process.cwd()`**。
- **父会话引擎**的工具 sandbox 在**隔离开关 ON 且已改绑时**（`isolationEnabled` 且 `taskRoot` 是 task worktree）对 `projectIdentityRoot` 放**只读**行（与 §1「读路径可留在主仓」同源；实现上是身份根整棵树的读放行 —— 它可能是主 checkout 的**子目录**，不是逐条身份路径白名单）；写仍不得进主仓。这条放行是本次改动新增的，OFF 档「今日」是**一条都不给**，所以门必须同时看开关：`taskWorktreeOwnerOf` 只是路径形状判断，单靠它会让一个恰好长成 `<X>/.iknow/worktrees/<name>` 的 cwd 在隔离关闭时拿到沙箱外的读放行。已知缺口（记在 `plans/worktree-live-task-root.md` 的 follow-up 段，尚未开 issue）：只 `read_file` 拿到这条放行，`grep` / `glob` 仍限在 `taskRoot`；子代理 worker 的 registry 也没拿到（worker 的说明书是灌进去的，不靠读）。
- 用户级 `~/.iknow`（画像、用户 rules / `AGENTS.md`、`init.sh`、trust）继续跟 `home`，既不跟 `productRoot` 也不跟 `taskRoot`。

### 5. 配置读取合同（硬要求 9）

开关只在**启动加载点**读取一次；config 层只承载 boolean 值域语义——**不读 git、不持会话状态**。会话根改绑**不隐式重载** project settings：settings 来源在会话生命周期内保持启动时的装配结果；如未来需要「改绑后重载 settings」语义，必须显式另立决定，不允许静默切换 settings 来源。

### 6. 失败语义 fail-closed（硬要求 6）

主仓不是 git 仓库 / git 不可用 / 创建工作树 ACI 工具失败（`git worktree add` 或改绑失败）：mutate 一律被拦下并给出**typed、非空、可见**的错误（对齐 harness fault-class 与 session-api `WorkspaceRootError` 的类型化错误惯例），**不静默放行写主仓**——建树/绑定失败后的主仓零写入是验收项，不是隐含假设。开关本身缺失或非法回落 OFF，即回落至今日行为，同一 fail-closed 来源。

### 7. 活 `taskRoot`（2026-09-02 reopen 新增）

`taskRoot` 不仅是会话装配期一次性解析的字段，而是**本 run 内会随建树 / exit 改写的活根**。其契约由下列子决定锁定（决定编号与 `plans/worktree-live-task-root.md` §5 D1–D11 同源；本 ADR 只锁合同边界，文件 / 函数名 / 类型名留给实施 bullet）。

#### 7.1 唯一 writer（D1）

活持有者位于会话根 SSOT 模块内部（既有唯一根策略点，doc 已声明「写与工具 cwd 只问它」）；`resolveSessionRoots` 保持纯函数不动——其「不读 git、不碰文件系统、不持会话状态」只约束它自己。**唯一写入口 = harness 装配层对 host `provision` / `enter` / `exit` 缝的包装点**（缝成功 resolve 时才写）。失败不写、不回滚，typed error 原样冒泡，主仓零写入不变。Hub / CLI 侧语义零变化，仍只观察返回根做 dirty-root 持久化。

#### 7.2 batch 快照语义（D2）

一次 `executeAll` 调用（= 一波 tool calls）只在入口读**一次**活根，整波共用该快照。理由：门禁对 mixed/mutating batch 逐 call 放行，逐 call 读活根会让同一波一半写旧根一半写新根——把一次逻辑改动劈进两棵树，违 least astonishment。rebind 因此对**同一 run 的下一波 tool calls**生效，而不是当波或下一回合。

#### 7.3 稳定根清单（D3，严禁活化）

下列根**全部**保持装配期冻结，不跟 `taskRoot` 改写：

- `productRoot`、`projectIdentityRoot`、`installRoot` —— 三者跨 rebind 不变（理由见 §4）。
- `mcpConfigRoot` —— 由 `productRoot` 派生，跨 rebind 保持稳定。
- `stateAnchor` + `memoryDir` —— per-root 状态锚，状态永不落进 gitignored 的树。
- `todoDir`、`traceDir` —— 同源稳定根。

特别是 ADR-0037 §4 已有约束：per-root 状态**永不**落进 gitignored 的树，活 `taskRoot` 不得拖动 `stateAnchor`。

#### 7.4 rebind 生效边界（run / 回合 既有词汇）

本 ADR 拒绝「下一 turn」这种含糊措辞，钉死用 `docs/CONTEXT.md` 已定义的 **一轮（run）**（:185）与 **turnCount**（:26）表述：

- 一**轮** = 一次 `run()`，从用户一句交代起到把控制权交还用户止；其间可含多次工具循环，落成多条 messages。
- 一**回合（turn）** = `run()` 内部一轮 assistant ↔ tool_result 闭环，每完成一个 assistant 回合 `turnCount` 加一。

`create-task-worktree` 在第 N 回合成功后，活 `taskRoot` 即翻到新根；按 7.2 的 batch 快照语义，**本回合内同一波的 mutate 仍走旧根**（整波一个快照值），从同一 run 的**下一波 tool calls** 起所有 mutate 都走新根。run 之间无需操作员再发消息，也不需要 `/continue`。这条生效边界直接关闭 `plans/worktree-live-task-root.md` §1 实测的「同 run 内 mutate 被永久拦死」病灶。

#### 7.5 mutator 门禁措辞校正

旧措辞「下一 turn 重发」按 7.4 的 run / 回合词汇校正：门禁文案与 `create-task-worktree` 工具成功文案都改为「本 run 内下一波 tool calls 将在新根上落地」，不再用「下一 turn」。

### 8. 显式撤销：same-turn mutator 列为非目标（2026-09-02）

原文 §1 / §2 隐含的「同会话内 mutate 在工具成功后的传播属于非目标，由操作员 `/continue` 触发下一轮」这条裁决，**自本 reopen 起撤销**。撤销理由两条，皆已实测或见 spec 原文：

1. **trace 实测反证**：2026-09-02 在 `conversation_id = d52e0f28-703c-439a-bce4-3a3ae1017139`（run `9b69b055`）的 trace 显示，turn 0 `create-task-worktree` 成功后，turn 1/3/4 三条 mutate 仍被同一句「未绑定」永久拦死，turn 5 的 read_file not_found 又是被拦 write 的下游后果。完整证据见 `plans/worktree-live-task-root.md` §1。
2. **spec 原文违反**：被 `4b4fa6fe` 撤销的修订版（model-provision amendment，`git show 4b4fa6fe^:docs/adr/0037-worktree-isolation-on-mutate.md`）明写「工具成功后 Host 只保证路径已切：**不同波重放**被拦的写、不偷偷代执行，被拦的写由模型在下一回合于新根上**自己再调**；**也不要求操作员 `/continue`**」。撤销这条旧裁决等于把 spec 原文恢复为现行合同。

新裁决：**同一 run 内，从 `create-task-worktree` 成功后下一波 tool calls 起，mutate 在新根落地；中间不需要操作员再发消息，不需要 `/continue`**。具体生效边界见 §7.4。

## Consequences

### Positive

- 多会话并行不再互踩：ON 时首个 mutate 后会话获得物理隔离的写目录，主仓保持只读。
- 默认 OFF 保证零回归路径；操作员显式 opt-in 才改变行为。
- git worktree ≠ workspace 多根的边界写死，避免把本开关与 serve 主根 / `workspaceRoot` 语义搅在一起。
- model-provision 契约与「活 `taskRoot`」补齐后，「拦下 → 工具建树 → 同 run 内 mutate 落地」整条链路零操作员介入，且 fail-closed 不降级。

### Negative / Trade-offs

- ON 时首次 mutate 引入建树成本与会话根切换，操作员需要能看出当前绑在哪棵树上（展示面由实施 bullet 落实）。
- 同名 task worktree / 分支已存在时 fail-closed 报错——残留的孤儿树需要人工清理后才可继续同名任务。
- 活根语义对消费者引入了一个新的「跨波生效」约束：消费者必须能容忍同 run 内批间根值变化，且必须按 batch 快照取根，不得在 handler 内跨多次 resolve 不同根。门禁自身按 §7.2 同步遵守。
- 「提交 → push → PR」的产品向导与 GitHub / `gh` 鉴权不在本 ADR 范围，另轨处理。

### Reversibility

- 开关 OFF 即完整还原今日行为；已建的 task worktree 是独立目录，删除即回收，不影响主仓与其它 worktree。
- §7 的活根机制可通过同一根 SSOT 接口反向关掉（writer 回到装配期一次冻结），不破坏会话根四角色分工。

## Evidence

- `plans/worktree-isolation-on-mutate.md` ACR 5/5 PASS（2026-08-29；bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier 全 yes）。
- `plans/worktree-isolation-model-provision.md` ACR 5/5 PASS（2026-08-30）——auto-provision → model-provision amendment 来源（issue #836，地图 #829）。
- 2026-08-31 amendment（commit `f6137d61`）：rebind 切 `taskRoot` 单字段，ADR-0019 per-root 状态锚不被搬走。
- 2026-09-02 reopen：实测证据见 `plans/worktree-live-task-root.md` §1（trace MCP 读 `conversation_id = d52e0f28-…`，run `9b69b055`，三条 mutate 被同源门禁拦死）；架构改造 ACR 5/5 **BLOCKED no** 落于 `plans/worktree-live-task-root.md` §4，五条 no 的 discharge 映射见同 plan §5 D1–D11；T2（本文 ADR 改写）为 reopen 的 decision record，无运行时代码。
