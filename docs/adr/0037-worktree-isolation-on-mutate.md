# 0037. 可选 worktree 隔离门禁：模型调 ACI 工具建树改绑 + 活 taskRoot（默认 OFF）

Date: 2026-08-29

Status: accepted

> **Amendment 2026-09-18**（ADR-0099）：项目记忆库也不跟 `workspaceRoot` 分片，落 `projects/<slug>/memory/`。
> **Amendment 2026-09-13**（ADR-0088）：§4「per-root 状态（记忆库落盘根 / tasks 登记）的锚是 `workspaceRoot`」对 **tasks** **superseded**——登记跟 home 项目树。记忆库仍 per-root。改绑仍只切 `taskRoot`，树上仍不另开一份登记。
>
> **Amendment 2026-09-11**：撤销「工具在场 ⇔ 门禁已武装」。工作树 ACI（create / enter / exit / list / remove）在 isolation host 缝在场时**常注册**，不再要求 `isolationEnabled`。`worktreeOnMutate` **只**武装 mutate 门禁（ON 拦未绑树的写、从不 auto-provision；OFF 主仓可写）。OFF 时模型仍可用 create/enter **session worktree rebind**。bash `git worktree add` 仍不是 rebind。本开关属**用户层** settings（项目文件出现 isolation 段则丢弃，ADR-0084）。§1 OFF「会话行为与今日完全一致、不新增任何拦截点」在**门禁**面上仍成立；**工具面**改为常在，不再随 OFF 卸掉。

> **Amendment 2026-09-04**：§1「读放行、写才拦」不变。bash 是否 mutate **不得**复用 `validateReadonlyCommand`（那是 bash readonly **模式**的 deny-by-default 表，`2>&1` 也拒）。门禁自备「会不会写工作区」判定；`2>&1` / 管道 / 只读命令串为读。`validateReadonlyCommand` 不为本门禁放宽。
> **Superseded 2026-09-19**（ADR-0109）：本 amendment 的判定核心——门禁对 **bash** 自备「会不会写工作区」预测判定 + 未知命令 fail-closed 拦——superseded：unbound 档围栏物理 `--ro-bind` 主 checkout，bash 一律放行、真写 EROFS 违例回灌。存续：`validateReadonlyCommand` 只服务 readonly 模式；FILE_WRITE / root_flip 的预测拦截；`unboundMutateNotice` 三段语义（条件式 + 重发指引 + 不按问句分型）与三条子串禁令（回灌文案沿用）。
> `unboundMutateNotice` 仍点名 `create-task-worktree`、仍不 auto-provision；文案改为事实阻断（这次调用会写主仓、未执行；若要写则调工具再重试这一次），不得把模型下一拍收成「去建树」（**此半句 2026-09-08 撤销**——回执只在写意图已证时出现，casual ask 结构上碰不到它，该顾虑在这个时点不成立；同批保留「不按用户问句分型」与三条子串禁令，并把验收从纯子串升级为**语义 + 子串**，因为纯子串断言拦不住语义空心化——本 amendment 锁定语义里的「再重试这一次调用」正是这样丢的）。不按用户问句分型。不改 `create-task-worktree` ACI 形状。

> **Amendment 2026-09-07**：§6 的「主仓不是 git 仓库」收窄为**可用 gitdir（usable gitdir）**判定——`not_a_git_repo` 仅当该会话根上**没有可用 gitdir**（`git rev-parse --git-common-dir` 或等价探测失败）时抛出；bare gitdir（`git init --bare`，无工作文件）与 `core.bare=true` 但仍带工作文件的检出，只要 `git worktree add -b` 能成功，都是**可用 git 仓**，建树照常进行。判据是「能不能从该根上建 linked worktree」，不是「根下有没有工作文件」——本仓自身的布局（gitdir + 工作文件同根、`core.bare=true`）即是合法输入。空目录 / 非 git 根仍 `not_a_git_repo`，且保持零写入；git 二进制 spawn 失败仍 `git_unavailable`；无 commit 的空 bare 仍是有 gitdir 的根、**不**收成 `not_a_git_repo`，`worktree add` 的成败由 git 自身裁决（实测随版本而异：旧版失败 → `worktree_add_failed`，git ≥2.53 自动 `--orphan` 成功）。门禁与 fail-closed 语义不变：建树失败后主仓零写入仍是验收项。

> Amendments: 2026-08-30 建树职责由 host 自动建树改为模型调用「创建工作树 ACI 工具」；2026-08-31 改绑只切 `taskRoot`（§4 重写）；2026-09-02 reopen——model-provision 契约 + 活 `taskRoot`（§7 新增）+ 撤销「same-turn mutator 列为非目标」（§8 显式撤销）；2026-09-05 bash 围栏身份根 ro-bind overlay + 模型可见写根（issue #891）；2026-09-06 reopen——bash 围栏闭世界化：全档位 deny-by-default 反转 + 读/写白名单裁决 + identity overlay 条款 superseded（§9 新增，issue #896）；2026-09-07 —— §6「主仓不是 git 仓库」收窄为可用 gitdir 判定（bare / `core.bare=true` 且能 `worktree add` 的根是可用仓）；2026-09-08 —— 写处境三态告知 + 告知面/回执分工原则 + 建树失败可恢复性分类轴（Amendment 2026-09-04 的反引导半句撤销，SC7 验收升级为语义断言；§7 活根语义与 §9 围栏均不变）；worktree 占用锁可选档位 `isolation.worktreeExclusive`（ADR-0070；与本开关正交、默认 OFF，§2/§3/§5 正文不变）；2026-09-09 —— §9.2 #3 `/tmp` 寿命改为每身份宿主垫底（ADR-0074）；可写集字面不变；2026-09-19 —— **bash 预测拦截翻转为物理 ro-bind 保证**（ADR-0109，`specs/worktree-unbound-ro-bind.md`；Amendment 2026-09-04 的 bash 判定核心与 §9.2 写白名单的 unbound 档标注 superseded / 补记，§1 ON 的 bash 半边失效；FILE_WRITE / root_flip 拦前、model-provision、活 taskRoot 与其余门禁条款均不变）。

> **Amendment 2026-08-30**（issue #836 / 地图 #829）：ON 时门禁**只拦写、不自动 `git worktree add`**——建 task worktree 与会话根改绑由**模型调用「创建工作树 ACI 工具」**完成（成功 = 树在且会话根已切到该路径）；Host 不同波重放被拦的写，被拦的写由模型在新根上自己再调。原文 Decision 1 中「首次 mutate 被拦截 → host `git worktree add` 建树改绑」的读法 **superseded**。同批修订：说明书（rules）改为按需读——父会话不整段灌 rules、缺目录视为空，见 ADR-0009 D2 的 amended 说明与 `docs/CONTEXT.md` 术语「说明书读法」。
>
> **Amendment 2026-08-30（工具面扩展，issue #839 / 地图 #829）**：enter/exit 对称工具——`enter-task-worktree` **显式进入**一棵本仓已存在的 task worktree（含他人树；授权锚 = 持久化的 `session.workspaceRoot`，只由工具成功 + 会话保存写成外来树，故是天然的显式进入持久记录；provision 据此 adoption 放行该会话在其上的 mutate），`exit-task-worktree` **回到主仓根**（主仓根由树经 git common dir 派生，重启安全）；exit **树保留不删**（孤儿树自动删除仍是明确非目标）。门禁本体不变。
>
> **Amendment 2026-08-31**（issue #855 / 地图 #829，`plans/worktree-session-roots.md`）：本节原文把「本会话生效的根锚」写成 `cwd` / `workspaceRoot` **一并**切到 task worktree，等于让 ADR-0019 的 per-root 状态锚与写隔离根撞在同一字段上——改绑后记忆库、tasks 登记、settings、说明书、permissions、项目 skills 全部跟着搬到 gitignored 的空树上。该读法 **superseded**：改绑只切 `taskRoot`。
>
> **Reopen 2026-09-02**（issue / 地图未定，`plans/worktree-live-task-root.md`）：原文 §1 描述的「首次 mutate 自动 `git worktree add` 建树改绑」（auto-provision）与已 shipped 的 model-provision 实现不符——`src/harness/isolation/worktree-gate.ts` 注释明写「NEVER provisions（no `git worktree add` on the execution path）」，建树职责完全落在「创建工作树 ACI 工具」上；门禁在「会写但还没建过树」这一中间态下只是一句「未绑定 → 请模型调工具」的可观察阻拦。同时，旧裁决隐含的「同 run 内 mutate 在工具成功后必须由操作员 `/continue` 触发」与 trace 实测直接冲突：拒绝会让用户放弃。本 reopen 三件事：(a) 在 §1 写齐 model-provision 契约；(b) 在 §7 新增活 `taskRoot` 决定（唯一 writer / batch 快照 / 稳定根清单 / rebind 生效边界）；(c) 在 §8 显式撤销「same-turn mutator 列为非目标」并写明撤销理由 = §1 的 trace 证据 + spec 原文「也不要求操作员 `/continue`」（被 `4b4fa6fe` 撤销的修订版原文）。

> **Accepted amendment 2026-09-03**（issue #869）：§3 的任务树叶子现在允许可选的合法 kebab label，形状为 `<label>--<conversationId>`；省略或非法 label 继续使用历史 `<conversationId>` 叶子，历史树不迁移。`taskWorktreeOwnerOf` 始终从最后一个 `--` 后的 conversationId 反演，label 只用于展示与按 label 定位，绝不参与归属裁决；任务分支在带 label 时采用 `iknow/task/<label>-<uuid8>`，碰撞仍 fail-closed。新增条件化、append-only 的 `list-task-worktrees`（只读）与 `remove-task-worktree`（显式回收）工具面，host 缝缺席时不注册；回收默认不删分支，脏树、未确认推送的独占提交和当前根均拒绝。建树后的可选 `.iknow/worktreeinclude` 只镜像匹配且已被 gitignore 的文件，且身份根只读通道扩展到 `grep` / `glob`；门禁、活 taskRoot、生效批边界、exit 保留树和 worker 所有权约束均不变。补记本次 reopen §3 的理由与取舍：叶子名兼职身份与展示的旧形状让人与模型都无法认树，label 因此只承接展示与定位，身份仍是 conversationId 后缀，`taskWorktreeOwnerOf` 的归属裁决逐字不变。代价是叶子反演从「整段叶子 = id」变为「取最后一个 `--` 之后的后缀」；选择纯路径反演而非登记表，因为零登记表 = 零新增状态，历史无 `--` 叶子天然兼容、无需迁移。依据为命名合同条款 1–5 与 SC1/SC6/SC9。

> **Amendment 2026-09-05**（issue #891 / `plans/891-taskroot-remaining-consumers.md`）：§4「写仍不得进主仓」落到 bash 物理围栏。实测（2026-09-05 复现脚本）：改绑后 bash 围栏的 `--bind $HOME $HOME` **后挂**于 cwd bind（`bindArgs` 非 `cwdReadonly` 分支），主仓在 home 下时被这个可写祖先罩住，`mkdir -p <主仓>/…` 穿透成功（exit 0）。修复不是新增第五根——写根仍是 `SessionRoots.taskRoot`，围栏只把 `projectIdentityRoot` 整棵树以 `--ro-bind` **后挂**在 writable home bind 之后（同一覆盖祖先纪律，`cwdReadonly` 已证明）：
>
> **Reopen 2026-09-06 注**：本 amendment 的 (a)(b)(d) 与 (e) 的 overlay 专属表述已被 §9 闭世界裁决 **superseded**（闭世界下无 writable 祖先可堵，identity 根降级为读白名单成员）；(c) fail-loud 存续，由 §9.4 继承扩展；(e) 的前后台同一 policy token 要求与 §7.2 batch 快照语义不受影响。见 §9.3。
>
> (a) **overlay 条件** = 隔离开关 ON 且活 `taskRoot` 已改绑（`taskWorktreeOwnerOf(taskRoot)` 有主）。未改绑时 cwd 就是主仓，mutate 由门禁拦，围栏 argv 不变。
> (b) **argv 顺序** = 身份根 `--ro-bind` 必须出现在 writable home `--bind` **之后**（bwrap 后挂子挂载覆盖祖先）；其它 token 逐字节不变。
> (c) **fail-loud** = 身份根空白 / 盘上不存在时抛 typed 可见错误、**不 spawn**；禁止 `existsSync` 静默跳过（与 `optionalHostRoBindArgs` 的存在性跳过不同轴：身份根是合同输入，缺席是配置故障，不是可选主机前缀）。
> (d) **OFF / 未改绑** = 不传 overlay 选项，`createBwrapFence` argv 与今日逐字节一致（`verify/sandbox-run.ts` 本轮不传）。
> (e) **模型可见面** = 改绑后模型（含子代理）经 worker prior messages / path-outside 回执看见当前写根 = 活 `taskRoot`；system `## Project path` 仍钉 `projectIdentityRoot`（`projectPathSegment` 字节不动），不静默改写 spawn `task` 正文。前台（`bash.ts`）与后台（`defaultBackgroundSpawn`）必须消费**同一** overlay token（CONTEXT 沙箱纪律：前后台共用围栏）。
>
> **Reopen 2026-09-06**（issue #896 / `plans/closed-world-bash-fence.md` T2）：bash 围栏物理形态从「writable home 打底 + 黑名单补罩」反转为**闭世界围栏（closed-world fence）**——home 下非白名单路径**不可见**（不是「可见但只读」），可写集 = `taskRoot` + `/tmp`，其余读通道 deny-by-default、按需 ro-bind。反转是**全档位**语义变更：OFF 档围栏同样闭世界（否则其它 project 在 OFF 档仍可写，病灶 1 不闭合；默认 FS 姿态 superseded by ADR-0092——默认全局档，不再闭世界）；§1 OFF 的围栏字节承诺、Amendment 2026-09-05 的 identity overlay 专属条款、Positive「默认 OFF 保证零回归」条目相应 **superseded**。白名单集合逐条裁决与 fail-loud 分型见 §9；Amendment 2026-09-05 的条款存废清单见 §9.3。证据源 = `scripts/sandbox-probe-closed-world.ts` 盘点（commit `d777c050`）实测 16 条 BREAK。**2026-09-13**：脚本已归档至 `archive/onetime-probes/closed-world-inventory-probe.ts`，npm 脚本 `probe:sandbox:inventory` 不再存在；§143、§216 同条引用改为内联（已归档）指针。

## Context

ADR-0023 裁决 4 曾锁定「v1 = 单根 + recents + 三锚合一；worktree/多根只读推迟」。当时推迟的对象是 **product workspace 多根**（serve 主根的多个绑定），而不是多会话共写同一目录的物理隔离问题。操作员后来提出的诉求是另一件事：多个会话（或会话与人在同一检出目录）并行改动会互相踩踏——解法是 git worktree，不是给 serve 再开几个主根。本 ADR 因此 **reopen ADR-0023 推迟面中一个窄例外**：会话级 git worktree 隔离，由全局开关控制、默认关闭；ADR-0023 的 serve 单根 + recents + 三锚合一语义原样保留，不被本 ADR 覆盖或静默修改。

边界先钉死：**git worktree ≠ product workspace 多根**。worktree 是 git 层的物理检出，服务「隔离写冲突」这一个目的；`workspace` / `workspaceRoot`（ADR-0019 / ADR-0023）是产品层的主根与 per-root 状态锚语义，本 ADR 不移动它们。

2026-09-02 reopen 的具体背景：本 ADR 原文 §1 把「拦下首次 mutate → host `git worktree add` 建 task worktree → 改绑当前会话根锚」描述为门禁侧的自动动作。该描述与已 shipped 的实现不符——`src/harness/isolation/worktree-gate.ts` 注释明写「NEVER provisions（no `git worktree add` on the execution path）」，建树职责完全落在「创建工作树 ACI 工具」上；门禁在「会写但还没建过树」这一中间态下只是一句「未绑定 → 请模型调工具」的可观察阻拦。同时，「同 run 内 mutate 在工具成功后必须落到新树」这条事实语义，与「same-turn mutator 列为非目标」的旧裁决直接冲突：trace 实测显示拒绝会让用户放弃。本 ADR 因此补齐 model-provision 契约、把 `taskRoot` 做成活根并显式撤销那条旧裁决。

## Decision

新增全局开关 `settings.isolation.worktreeOnMutate`（boolean-only，**默认 OFF**；缺失或非 `true` 一律按 OFF，与 `settings.memory.autoExtract` 同款 fail-closed 值域纪律）。精确的字段接线与类型落点由实施 bullet 落在 `src/config`（唯一 fail-closed 读取点见 `src/config/settings.ts:236`），本 ADR 锁的是语义合同。

### 1. 开关两态（硬要求 1）

- **OFF（默认）**：会话行为与今日完全一致——读、写、permission、目录全部现状，不新增任何拦截点。（**2026-09-06 reopen 标 superseded，仅就 bash 围栏物理面**：OFF 档围栏同样闭世界化，见 §9.1；门禁、根改绑、permission 语义不变。默认 FS 姿态 superseded by ADR-0092：默认全局档。）
- **ON**：会话可**只读**主仓（read / grep / glob / 只读 bash 等读路径放行，可留在主仓）；一旦出现**写路径**（write_file / edit_file / 会改工作区的 bash 等 mutate），门禁把该写**拦住**——host **不自动** `git worktree add`，而是由**模型调用「创建工作树 ACI 工具」**完成建 task worktree（含 task 分支）与**当前会话**根锚改绑；工具成功 = 树已在且会话根已切到该路径，此后本会话 mutate 只进该根。已绑定本会话 task worktree 时写路径直接放行，不建第二棵树。（**Superseded 2026-09-19，仅 bash 半边**（ADR-0109）：「会改工作区的 bash」不再被预测拦——unbound 档围栏物理 `--ro-bind` 主 checkout，bash 一律放行，真写以 EROFS 违例回灌、文案点名 `create-worktree`；write_file / edit_file 拦前存续，「不 auto-provision」不变。）
- **正交档位 `isolation.worktreeExclusive`（2026-09-08 新增，ADR-0070）**：与本开关**正交**，boolean-only、默认 OFF、同款 fail-closed 值域纪律。ON 时 `enter-task-worktree` 多一道前置检查——目标树若被**别的现存会话**占用（判据 = 现存会话记录的 `workspaceRoot`，零新持久状态）则 typed 拒绝（`worktree_claimed`）。**本节 OFF / ON 两态语义与门禁裁决逻辑均不变**；OFF 档 enter 行为与今日逐字节一致。

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

「主仓不是 git 仓库」的判定边界（2026-09-07 amendment）：`not_a_git_repo` 的**唯一**触发条件是该会话根上没有可用 gitdir（`git rev-parse --git-common-dir` 或等价探测失败）。bare gitdir 与 `core.bare=true` 但能 `git worktree add` 的检出都是可用 git 仓，不因「根下没有 / 不只是工作文件」被误判成非 git——判据是建树能力，不是工作文件存在性。git spawn 失败 → `git_unavailable`。无 commit 的空 bare **仍是可用 gitdir，永不收成 `not_a_git_repo`**：`git worktree add` 的结果由 git 自身裁决且随版本而异（旧版因无 HEAD 可分支而失败 → `worktree_add_failed`；git ≥2.53 实测自动推断 `--orphan` 成功建树），建树函数不替 git 预判。

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
- `stateAnchor` —— per-root 状态锚（settings 写回 / worktrees），状态永不落进 gitignored 的树。
- `memoryDir` —— home 项目树 `projects/<slug>/memory/`（ADR-0099），跨 rebind 冻结，不跟 `taskRoot`。
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

### 9. bash 围栏闭世界化：全档位 deny-by-default 反转与白名单裁决（2026-09-06 reopen）

> **Superseded 2026-09-13**（ADR-0092）：本节裁定的**默认 FS 姿态**superseded——默认不再是闭世界围栏（**全局档**：宿主真路径可读可写，home 不藏），会话 tmp 改用宿主路径、不再 bind 成 `/tmp`。围栏仍跑（网络 / env / rlimit / FS 沙箱）。工作区档（后做）可复用 §9.2 的写白名单。

本节由 `plans/closed-world-bash-fence.md` T2 落盘，承接该计划「背景与病灶」三件：writable home 打底下其它 project / home 下任意路径在围栏内可写（黑名单永远枚举不完）、持久执行配置只有 `overlaySensitivePaths` 一层 tmpfs 罩、`~/.iknow/init.sh` 是被执行的持久文件（#896 的核心疑虑）。证据源：`scripts/sandbox-probe-closed-world.ts`（**2026-09-13 已归档**至 `archive/onetime-probes/closed-world-inventory-probe.ts`）盘点（commit `d777c050`）——在「系统 ro-bind + cwd 可写 + /tmp、无 writable home bind」的假设围栏下逐条实测合法场景，产出 16 条 BREAK（node/npm/npx/bun exit 127 command not found、git 全局 config 读取与 worktree 操作 exit 128、`~/.iknow` / `~/.claude` 不可见 exit 2、login shell rc 不可读、主机 PATH 的 home 条目全部不可达等）。

**闭世界围栏（closed-world fence）**：home 下非白名单路径**不可见**——不是「可见但只读」，是 mount 面上不存在；可写集 = `taskRoot` + `/tmp`；白名单之外的读通道一律 deny-by-default，按需以 ro-bind 显式放行。（默认 FS 姿态 superseded by ADR-0092：默认全局档。）

#### 9.1 全档位语义反转（a）

- 反转适用于**全部档位**（OFF / ON / 改绑后）：OFF 档的 bash 围栏同样闭世界。（默认 FS 姿态 superseded by ADR-0092：默认全局档，不再闭世界。）理由：若 OFF 档保留 writable home，其它 project 在默认档仍可写，病灶 1 不闭合，反转对默认使用面无意义。
- 因此 **superseded**（仅就 bash 围栏物理面）：§1 OFF「会话行为与今日完全一致」中围栏 argv 与 home 可见性的承诺；Amendment 2026-09-05 (d)「OFF / 未改绑 = argv 与今日逐字节一致」；Positive「默认 OFF 保证零回归路径」。§1 OFF 其余语义（门禁不拦、根不改绑、permission 现状）不变。
- harness 层写（memory_save / settings 写回 / trust / recents / state.json）不经 bash 围栏，闭世界不触及；#896 的「memory_save 兼容面」因此不构成白名单项。

#### 9.2 读/写白名单裁决（b）

读白名单逐条列名 + 在场理由（每条可溯源到盘点证据）：

1. **系统前缀** `/usr` `/bin` `/lib` `/lib64` `/etc`（现状保留）+ 可选主机前缀 `/opt` `/snap`（存在性跳过，现状保留）——工具链与基础命令的宿主；反转不拆除这组既有 ro-bind。
2. **`taskRoot`（cwd）**——可写 bind，工作树本体。「写与工具 cwd 只问它」（§4）在物理面落为这条可写 bind。
3. **`/tmp`**——可写。进程临时面，也是 npm / pip 等被拒缓存写的落点。后端与寿命见 ADR-0074（每身份宿主垫底，跟会话走）；不是交付落点。（bind 面 superseded by ADR-0092：会话 tmp 用宿主路径，不再 bind 成 `/tmp`；每身份一块与寿命仍保留。）
4. **`installRoot`**——`resolveSessionRoots` 既有第四角色（§4），项目自身工具链（`node_modules/.bin`、tsc 等）的读通道；合同输入，fail-loud 见 §9.4 配置故障型。
5. **node 工具链根** = `dirname(process.execPath)`（运行 harness 的 node 所在目录），npm / npx 随 node 根可达。盘点实测：围栏内 node / npm / npx 全部 exit 127 command not found、`which node` exit 1（本机 node 链 = `~/node/bin`，非 `~/.nvm` 形态）。若 node 本就在系统前缀下，该根与第 1 条去重塌缩，不新增 bind；合同输入。
6. **`projectIdentityRoot`（主仓 checkout）**——闭世界下**恒进**读白名单，不再是条件 overlay / 条件只读放行（§4「父会话引擎的工具 sandbox…放只读行」配套约束由本条接管）。主仓 `.git` gitdir 随之可达，修复盘点实测的 worktree repo 发现断链：`git -C <taskRoot> status` / `git var GIT_COMMITTER_IDENT` exit 128 `fatal: not a git repository`——worktree 的 `.git` file 指向主仓 gitdir，主仓不可达时 repo 发现先死。仅 `isolationEnabled` 时由装配层提供（与今日传递条件一致；未改绑时 `.git` 就在 cwd 内，本不缺读通道），不再以「已改绑」为条件；合同输入，fail-loud 见 §9.4 配置故障型。
7. **git 全局配置** `~/.gitconfig` 与 `~/.config/git/config`——**可选读成员，存在性跳过**（缺席不炸，不同于合同根）。修复盘点实测的 `Committer identity unknown`（`cd /tmp && git var GIT_COMMITTER_IDENT`，纯身份轴钉在 @/tmp 隔离条上）。缺席时 git 身份解析失败 = 运行时可观察错误（§9.4 运行时可观察型）；单文件只读，风险面低。

**写白名单：`taskRoot` + `/tmp`，无第三者。**（默认 FS 姿态 superseded by ADR-0092：默认全局档；工作区档可复用本白名单。**ADR-0109 补记 2026-09-19**：worktree 门禁 ON ∧ unbound（waveRoot = 主 checkout）档，该根的可写 bind 之上再后挂 `--ro-bind` 主 checkout（rw bind 后、`--proc` 前，last-mount-wins），`taskRoot` 档上的真写实际 EROFS；session fence tmp pad 在后挂之后重绑 rw，scratch 写走 pad。bound / gate OFF 档本白名单逐字节不变。）

明确不进白名单（拒绝理由在案，防止日后重提）：

- **`~/.bun`**：bun 仅 host 测试工作流使用，围栏内断链可观察、可接受（盘点：`bun -v` exit 127，证据在案）。
- **npm / pip 缓存**：可重建，围栏内的缓存写应落 `/tmp`（盘点：缓存目录可达性 test exit 1，连带不可达）。
- **`~/.claude`**：凭证与会话数据面，读也不放行（盘点：`ls` exit 2 不可见，维持）。
- **shell rc 文件**（`~/.bashrc` / `~/.profile`）：login bash 已可用（盘点：`bash -lc 'echo ok'` exit 0，rc 不可见对 login bash 非致命）；rc 不可见消除持久副作用面，是接受项甚至有利面。
- **`~/.iknow`**：读放行 = 可执行面（`init.sh` 是被执行的持久文件，#896 关闭的正是这个面）；memory 写不经 bash 围栏，不需要读通道（盘点：`ls ~/.iknow` exit 2；`init.sh` 主机即不存在 = skip）。
- **`~/.ssh`**：by-design（盘点同条，不可见即设计意图）。
- **PATH 透传（裁决：不做重建 / env 剔除）**——PATH 经 `BASE_ENV_WHITELIST` **原样透传**入围栏，无 env 装配层的剔除/重组；home 下不可达条目在 mount 面「自然失联」（目录不可见 → 命令解析失败），env 本身不被改写。盘点：主机 56 条 PATH 中 home 下条目全部不可达；断链 = 运行时可观察型（§9.4），不自动扩白名单。

#### 9.3 Amendment 2026-09-05 identity overlay 条款 superseded（c）

理由：闭世界下 home 不可写，「writable 祖先罩住主仓」的病灶消失；overlay 是对 writable-home 形态的补罩，母形态消失后即无操作，identity 根降级为 §9.2 第 6 条读白名单成员。

- **superseded**：(a) overlay 条件（ON 且已改绑才挂 overlay）；(b) argv 顺序合同（身份根 `--ro-bind` 后挂于 writable home `--bind` 之后的覆盖排序）；(d) OFF / 未改绑 = argv byte-identical；(e) 中「同一 overlay token」的 overlay 表述。
- **存续**：(c) fail-loud 条款（身份根空白 / 盘上不存在 = typed 错误不 spawn、禁止 `existsSync` 静默跳过）不 superseded，由 §9.4 配置故障型继承并扩展到全部合同输入根；(e) 的模型可见写根语义与 §7.2 batch 快照语义（D2）不 superseded——前台（`bash.ts`）与后台（`defaultBackgroundSpawn`）同一波必须消费**同一份围栏 policy** 的要求换表述保留（CONTEXT「沙箱纪律」不变）。

#### 9.4 白名单 miss 的 typed fail-loud 分型与 EXIT 条款（d）

- **配置故障型（合同输入，spawn 前 fail-loud）**：白名单合同根**空白或盘上不存在**——`installRoot` / `projectIdentityRoot` / `taskRoot` / tmp / node 工具链根（§9.2 第 2、4、5、6 条与写根）。抛 typed error（`ToolExecutionError` 系，对齐 Amendment 2026-09-05 (c) 纪律），**不 spawn**、不 `existsSync` 静默跳过。错误面：工具执行直接抛错并冒泡到调用方。**EXIT = 该 tool call 失败**，会话不静默降级。
- **运行时可观察型（工具链断链）**：未放行二进制不可达（如 `~/.nvm` 形态的 node 链）、PATH 原样透传下 home 条目失联导致命令找不到（§9.2「PATH 透传」——无 env 装配层剔除/重组）、git 身份缺失、可选 git 全局配置缺席（§9.2 第 7 条）。命令以非零退出码 + stderr 经 tool result 正常冒泡，**不静默降级、不自动扩白名单**。错误面：模型在 tool result 层观察失败。**EXIT = 单命令失败**，由模型在 tool result 层观察并处理（换命令 / 改道 / 上报）。

## Consequences

### Positive

- 多会话并行不再互踩：ON 时首个 mutate 后会话获得物理隔离的写目录，主仓保持只读。
- 默认 OFF 保证零回归路径；操作员显式 opt-in 才改变行为。（**2026-09-06 reopen 标 superseded**：围栏反转是全档位语义变更，OFF 档 bash 围栏同样闭世界，见 §9.1。**默认 FS 姿态 superseded by ADR-0092**：默认全局档。）
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
- 2026-09-06 reopen：闭世界断链实测见 `scripts/sandbox-probe-closed-world.ts`（**2026-09-13 已归档**至 `archive/onetime-probes/closed-world-inventory-probe.ts`）盘点（commit `d777c050`）——16 条 BREAK（node/npm/npx/bun exit 127、git 全局 config 读取与 worktree repo 发现 exit 128、`~/.iknow` / `~/.claude` 不可见 exit 2、login shell rc 不可读、PATH home 条目不可达等）；白名单集合裁决与 fail-loud 分型见 §9（`plans/closed-world-bash-fence.md` T2）。
