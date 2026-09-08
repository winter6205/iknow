# Spec: worktree 占用锁（可选档位）

> 承接 `specs/write-situation-disclosure.md`（告知面与出口）。本 spec 是**新增一个策略档位**，不是修告知面：默认档行为与今日逐字节一致，操作员显式打开后才多一道拦截。
>
> **依赖**：`write-situation-disclosure.md` 的可恢复性穷尽表（新 kind `worktree_claimed` 要进表）。两份 spec 不共享代码改动面，但实施顺序上本份在后。

## Glossary（exact copy from docs/CONTEXT.md）

- **session worktree rebind**: worktree isolation mode ON 下 `create-task-worktree`（或 enter / exit）ACI 工具成功后，把**当前会话**生效的根锚切到本会话 task worktree 的动作；只影响本会话——不 checkout 其它会话 / 其它 worktree 的 HEAD……同会话重复调工具幂等（一棵树、一个 task 分支，不跑第二次 `git worktree add`）。
- **task worktree label**: 给人/模型认树的 kebab 目录名。有合法 label 时叶子就是 `<slug>`，conversationId 不进文件夹（写在 gitdir sidecar；历史 `<slug>--<conversationId>` 仍可反演）。
- **taskRoot**（活值）: 会话当前生效的 task worktree 根——**写与工具 cwd 只问它**。
- **unbound**: 没有可校验 `workspaceRoot` 的过渡或遗留无效状态，不是正常产品状态。……serve 当前无 flag/env 时绑定 `<homedir>/.iknow/default`，不属于 unbound。

（完整句以 `docs/CONTEXT.md` 为准，本 spec 不重定义。）

## Architectural Constraints

- **ADR-0037 §2**：改绑只影响本会话；子代理跟随父会话同一棵树，不触发第二棵树。
- **ADR-0037 §3**：fail-closed——不静默覆盖、不复用归属不明的树、不 checkout 其它会话的 HEAD。
- **ADR-0037 §5**：开关**只在启动加载点读取一次**；config 层只承载 boolean 值域语义，不读 git、不持会话状态；会话根改绑**不隐式重载** settings。
- **ADR-0037 Amendment 2026-08-30（工具面扩展）**：`enter-task-worktree` 显式进入一棵本仓已存在的 task worktree（**含他人树**）；授权锚 = 持久化的 `session.workspaceRoot`，只由工具成功 + 会话保存写成，故是**天然的显式进入持久记录**；`exit-task-worktree` 回主仓根，**树保留不删**（孤儿树自动删除仍是明确非目标）。
- **`settings.isolation.worktreeOnMutate` 的值域纪律**（`src/config/settings.ts:223-226`、单读点 `:299-303`）：boolean-only、默认 OFF、缺失或非 `true` 一律按 OFF（fail-closed）。本 spec 的新开关**同款**。
- **ADR-0023**：serve 主根 / recents / unbound 语义不被本 spec 触碰。
- **`write-situation-disclosure.md`**：可恢复性穷尽表是本 spec 新 kind 的落点；归属 sidecar 的职责是**告知**，不是授权。

## Objective

**What:** 新增 `isolation.worktreeExclusive`（boolean-only，默认 OFF）。ON 时 `enter-task-worktree` 多一道检查：目标树若被**别的现存会话**占用，typed 拒绝。占用判据**只有**现存会话记录里的 `workspaceRoot`——不新增任何持久状态。

**Why:** 今天 `enter-task-worktree` 的四道检查（`worktree-rebind.ts:896-944`：调用方在主仓 / 目标存在 / 目标是 linked 检出 / 同仓库）**没有一道是归属**，所以两个活会话可以同时绑同一棵树：交错编辑、共享同一个 git index、提交互相插队。ADR-0037 的立项理由正是「多个会话并行改动会互相踩踏」，而这条路径上今天没有闸。

但默认档**不该**变：操作员平时不需要锁，锁只在「确实要隔离每棵树的归属」时才开。所以做成可选档位，而不是把排他变成默认。

**Who:** 需要多会话并行、且要求每棵树单一占用者的操作员。

## Boundaries

- **Does:**
  - 新设置项 `isolation.worktreeExclusive`，与 `worktreeOnMutate` **同一套纪律**（boolean-only / 默认 OFF / fail-closed / 装配期读一次 / 改绑不重载）。
  - ON 时 enter 前置检查占用；撞上 → 新 kind `worktree_claimed`，回执点名占用者会话 + 释放路径。
  - `worktree_claimed` 进可恢复性表，归 `operator_required`（模型解不了别人的占用）→ 回执自带停止指令。
- **Confirms with human:**（本 session 已确认，不再开口）**不做** `force` 参数、**不做** `release` 命令、**不做**活性检测（PID / 心跳）、**不做**锁文件、**不做**占用注册表。恢复走既有路径（见 Assumptions 3）。
- **Out of this spec:** 见文末「后续（本 spec 不做）」。

## Success Criteria

1. **值域纪律**：`isolation.worktreeExclusive` boolean-only；缺失 / 非 `true` 一律按 OFF；**只在启动加载点读一次**，会话根改绑不触发 settings 重载（对齐 ADR-0037 §5 与 `resolveWorktreeOnMutate` 单读点形状）。
2. **OFF 档零回归**：OFF 时 `enter-task-worktree` 的行为与今日**逐字节一致**——四道检查不变、不新增任何拒绝路径、回执不新增任何句子之外的内容。要有断言锁死。
3. **ON 档拦截**：目标树的 `workspaceRoot` 出现在**别的**现存会话记录里 → typed 拒绝，`kind === "worktree_claimed"`，回执含**占用者会话 id** 与**释放路径**（恢复那个会话让它自己 `exit-task-worktree`，或删除该会话记录）。
4. **ON 档放行**：无任何现存会话记录指向目标树 → enter 照常成功，行为与 OFF 档一致。
5. **自占用不算占用**：占用者就是本会话（幂等 re-enter）→ 返回同一根、**零写**，与今日 `if (current === target) return target` 行为一致。
6. **进可恢复性表**：`worktree_claimed` 在 `Record<WorktreeIsolationErrorKind, Recoverability>` 里有分类且为 `operator_required`，因此回执自带停止指令（「重试无用 / 报给操作员」等价）。漏分类 → `npm run typecheck` 失败。
7. **零新持久状态**：不写锁文件、不给 owner sidecar 加字段、不建占用注册表、不加内存 Map 跨调用存活。判据**只有**现存会话记录的 `workspaceRoot`。代码审查项：本 spec 的 diff 不得新增任何写盘路径。
8. **无 force**：`enter-task-worktree` 的 `inputSchema` **不新增**任何覆盖 / 强制字段。被锁约束的一方不得持有覆盖开关，否则锁等于建议。
9. **恢复路径可走通**：至少一条有测试——删除占用会话记录后，另一会话 enter 成功。（另一条路径「恢复该会话并让它自己 exit」依赖 restart-safe 设计，见 Assumptions 3，属既有行为，本 spec 不改。）
10. **归属告知不受本开关影响**：`write-situation-disclosure.md` SC10 的「enter 成功回执告知创建者」是**恒定开**的；OFF 档也必须告知。两个特性互不为前提。
11. **绿线**：`npm test` 与 `npm run typecheck` exit 0。

### 已知限制（必须写进实施与文档，不得含糊）

- **L1 枚举范围**：占用判据依赖「枚举现存会话记录」。**入口与成本未验**（见 Open Questions 1）。若代价过高而退回「只查当前 hub 已加载的会话」，则语义**弱一档**：跨进程 / 跨 hub 的占用看不见，两个独立 CLI 进程可以同时 enter 同一棵树而互不拦截。退回时必须在设置项文档、回执文案与本 spec 三处显式写明，**不得**让操作员以为拿到了跨进程排他。
- **L2 并发 TOCTOU**：占用来自**持久化记录**，而记录在「工具成功 + 会话保存」时才写。两个会话在**同一时间窗**内 enter 同一棵尚未被任何记录指向的树，可能都读到「无占用」而双双成功。本 spec **不解决**——解决它需要锁文件或注册表，已在 Confirms with human 明确不做。要求：该窗口在文档里写明为已知限制，且 L1 的枚举越全，窗口越窄。

### 输入五类（S2，实施必须覆盖）

| 类         | 输入                                                      | 期望                                                                 |
| ---------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| empty      | 会话记录枚举为空 / 记录缺 `workspaceRoot` 字段 / 字段空串 | 视为**无占用**，放行；不 throw、不静默拒绝                           |
| negative   | OFF 档 + 目标树确被别人占用                               | **放行**，行为与今日逐字节一致（SC2）                                |
| overflow   | 极多会话记录 / 极长绝对路径 / 尾随分隔符                  | 仍按 `workspaceRoot` 路径相等裁决（归一化后），不退化成笼统拒绝      |
| concurrent | 两会话同窗 enter 同一棵无记录树                           | 按 L2 写明：允许双双成功，但必须有测试**钉住这个行为**，不得假装互斥 |
| exception  | 会话记录读取抛 I/O（非 ENOENT）                           | 原样 rethrow 或 typed fail-closed；**不得**静默当成「无占用」放行    |

## Open Questions

1. **枚举现存会话记录的入口与成本**：`hub` 有 recents / sessions，但是否有现成索引、跨 root 怎么算、一次枚举要读多少文件——**未验**。实施第一步必须先答这个，因为它决定 SC3 的语义强度与 L1 是否触发。若单次 enter 的枚举成本超过一次 git 子进程量级，应退回 L1 的弱档并显式标注。

## Inherits / Changes

**Inherits:** ADR-0037 §2/§3/§5 与 Amendment 2026-08-30（enter/exit 语义、树保留不删、授权锚 = 持久化 `session.workspaceRoot`）；`worktreeOnMutate` 的 boolean-only / fail-closed / 单读点纪律；`enter-task-worktree` 既有四道检查与幂等 re-enter；owner sidecar 与 `taskWorktreeOwnerOf`；`write-situation-disclosure.md` 的可恢复性穷尽表与「归属 sidecar 只负责告知」定位；restart-safe adoption（`worktree-rebind.ts:790-798`）与 `initiallyBound`（`worktree-gate.ts:913`）。

**Changes:**

- **ADR-0070（新）**：worktree 占用锁档位——占用判据 = 现存会话记录的 `workspaceRoot`（零新状态）；释放 = 显式 exit 或删除会话记录（不做 `release` 命令、不做活性检测）；模型侧无 `force`。
- **ADR-0037**：Amendments 行加 0070 指针；§1 补一句「ON 档另见 `isolation.worktreeExclusive`」；**§2/§3/§5 正文不改**。
- **`docs/CONTEXT.md`**：新增 **占用（worktree claim）** 词条——含「只告知不授权」的 sidecar 定位与「释放靠显式 exit」的语义。
- **`specs/README.md`**：活跃表加本文件一行。
- **代码**：`src/config/settings.ts`（新设置项 + 单读点）、`src/session-api/worktree-rebind.ts`（enter 前置检查 + 新 kind 抛出）、`src/harness/isolation/worktree-gate.ts`（**仅** `WorktreeIsolationErrorKind` 加 `worktree_claimed` 成员——该文件已 1167 行，不追加逻辑）、`src/harness/isolation/recoverability.ts`（往 `write-situation-disclosure.md` 新建的穷尽表**加一行**）、`src/harness/build-engine.ts`（装配期读取并透传）。**不改** `exit-task-worktree` / `remove-task-worktree` / 门禁裁决逻辑 / 围栏。

## ACR

`architecture-change-reviewer` 实跑输出（2026-09-08，与 `specs/write-situation-disclosure.md` 联合受审）：

```
bounded-context-guardian: yes — boolean 值域留 config（settings.ts:223-226 / :299-303 同款单读点，不读 git、不持会话状态，ADR-0037 §5）；占用判定留 session-api（worktree-rebind.ts 本就 import 并 throw WorktreeIsolationError，:890 实证）；kind 与分类表留 isolation；无技术分层切片、无反向依赖。
defensive-contract-validator: yes — 五类表全部分配、无造假：concurrent 要求测试钉住 TOCTOU 双成功而非假装互斥；exception 禁静默当无占用；overflow 覆盖多记录与路径归一化；empty 覆盖记录缺字段。
error-handling-enforcer: yes — 新 kind worktree_claimed typed 而非布尔返回、进穷尽表拿停止指令；SC7 禁新增写盘路径；exception 臂显式禁 fail-open；「记录缺 workspaceRoot → 放行」不是 fail-open——缺字段的记录语义上确实不构成占用，与 I/O 故障区分正确；L1/L2 写成显式已知限制而非藏在实现里。
complexity-anti-drift: yes — 一道前置检查 + 一个 boolean 设置 + 表里一行；不新增状态机、不新增持久结构、不改 gateMutate；SC8 禁 force 参数。
minimal-change-verifier: yes — 两份 spec = 两个 destination，拆分正确：本份加新策略档位（默认档逐字节零回归），disclosure 份修既有行为可信性（默认档行为改变），合并会把 bug-fix 与新 feature 混进一个 commit；本份对 disclosure 份的依赖（穷尽表落新 kind）已声明实施顺序，非环。
OVERALL: PASS — hand to writing-plans
```

**ACR 对 L1 / L2 的核查结论**：「L2 的 TOCTOU 是『零新持久状态』（SC7）+『不做锁文件』（Confirms with human）的必然推论，spec 选择了钉住行为而非假装互斥，且给了收窄机制（L1 枚举越全窗口越窄）。L1 的弱档退回有三处强制披露要求。**是诚实限制，不是遮掩。**」

## 待写入

- `docs/CONTEXT.md` 新增：**占用（worktree claim）**。
- `docs/adr/0070-worktree-exclusive-claim.md`（新）。
- `docs/adr/0037` Amendments 行加 0070 指针 + §1 一句指针。

## Assumptions（本 session 已确认，不再当作 Open Questions）

1. 锁是**可选档位**，默认 OFF。操作员平时不用锁；打开即接受「释放靠显式 exit」。
2. 占用**不需要新状态**——它就是会话存档里已有的 `workspaceRoot` 字段。会话正常 exit → 字段改回主仓 → 占用自动消失 → 别人自然能进。
3. **僵尸占用不是不可恢复态**：会话是持久可恢复的，恢复 A 会话时引擎带着 A 的绑定起来（`worktree-rebind.ts:790-798`「restart-safe explicit opt-in」、`worktree-gate.ts:913` `initiallyBound`），A 自己调 `exit-task-worktree` 即释放。不丢历史、不删会话、不需要新命令。
4. 因此**不做** `release`：它的唯一独立价值是「解绑但保留会话记录」，而 (3) 已经能不丢历史地解绑。若将来真的出现「为放开一棵树而不得不删掉想留的历史」并且觉得痛，再补，形状已想清（只改绑定记录、不动树、不动未提交改动）。
5. **不做活性检测**：PID 探活有进程号复用与跨机失效，心跳要每会话一个定时器；两者都是「不能保证百分百」的机制，而 (3) 已用既有设计覆盖同一需求。
6. `enter-task-worktree` 今天**允许**进他人树（四道检查无归属），这是本 spec 要可选地收紧的行为，不是 bug。

## 后续（本 spec 不做）

1. **`force` / 覆盖入口** — 模型侧永不加（SC8）。操作员侧若将来需要，形状是「解绑而不删树」，见 Assumptions 4。
2. **活性检测 / 锁文件 / 占用注册表** — 见 Assumptions 5；且任何跨进程共享状态一旦失效就回到僵尸问题，与 (3) 的零新状态取向冲突。
3. **L1 升级到跨进程排他** — 需要共享状态，重新考虑的条件：实测到两个独立进程同时写一棵树造成真实损坏，且操作员明确要求跨进程排他。
4. **`remove-task-worktree` 与占用的交互** — 今天它拒脏树、拒未推送独占提交、拒当前根。ON 档下「删一棵被别人占用的树」该不该另加一道拒绝，本 spec 未裁决；等 L1 的枚举入口定了再议，避免在未知成本上先立语义。
5. **明确不做** — 把排他变成默认档；用 sidecar 归属当授权（sidecar 只负责告知）；把锁与 `write-situation-disclosure.md` 的归属告知耦成一个开关。
