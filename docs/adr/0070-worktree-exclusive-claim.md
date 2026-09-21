# 0070. worktree 占用锁：可选档位、零新状态、释放靠显式 exit

Date: 2026-09-08

Status: accepted

> 依赖同日建立的可恢复性分类轴（新 kind `worktree_claimed` 进表）。

## Context

`enter-task-worktree` 今天有四道检查（调用方在主仓 / 目标存在 / 目标是 linked 检出 / 同仓库），**没有一道是归属**。因此两个活会话可以同时绑同一棵树：交错编辑、共享同一个 git index、提交互相插队。ADR-0037 的立项理由正是「多个会话并行改动会互相踩踏」，而这条路径上没有闸。

同时，操作员日常并不需要这把锁——多数时候允许共用（例如新会话接手上一会话保留下来的树继续任务）正是想要的工作流。所以问题不是「要不要排他」，而是「排他该不该是默认」。

一个已被排除的错误方向：把 owner sidecar 当授权凭据。sidecar 的职责是**告知**，且 `enter-task-worktree` 刻意不查它；用它当锁会把「新会话接手旧树」这条正当工作流一并堵死。

## Decision

### 1. 可选档位

新增 `isolation.worktreeExclusive`（boolean-only，**默认 OFF**），与 `isolation.worktreeOnMutate` **同一套值域纪律**：缺失或非 `true` 一律按 OFF（fail-closed）；只在启动加载点读取一次；config 层不读 git、不持会话状态；会话根改绑不隐式重载 settings（ADR-0037 §5）。

**OFF 档行为与今日逐字节一致**——四道检查不变、不新增任何拒绝路径。零回归是本档位的验收项，不是隐含假设。

### 2. 占用判据：现存会话记录的 `workspaceRoot`

ON 时 enter 前置一道检查：目标树是否被**别的现存会话**占用。

**占用 = 现存会话记录里有别人的 `workspaceRoot` 指着这棵树。** 判据只有这一条。

于是释放是自动的：会话正常 `exit-task-worktree` → 其 `workspaceRoot` 改回主仓根 → 占用消失 → 别人自然能进。**不需要任何释放机制。**

### 3. 零新持久状态

不写锁文件、不给 owner sidecar 加字段、不建占用注册表、不加跨调用存活的内存 Map。

这条是硬约束而非偏好：任何跨进程共享状态一旦失效（进程崩溃、机器重启、记录过期）就重新制造僵尸占用，而僵尸占用正是本 ADR 要消除的东西。用既有字段当判据，僵尸问题在定义上不存在——**记录不在，占用就不在**。

### 4. 僵尸占用的恢复走既有路径

会话是持久可恢复的：恢复 A 会话时引擎带着 A 的绑定起来（`worktree-rebind.ts:790-798`「restart-safe explicit opt-in」、`worktree-gate.ts:913` `initiallyBound`），A 自己调 `exit-task-worktree` 即释放。**不丢历史、不删会话、不需要新命令。**

次级路径：删除该会话记录，占用同样消失（代价是丢掉那段历史）。

### 5. 模型侧无 force

`enter-task-worktree` 的 `inputSchema` **不新增**任何覆盖 / 强制字段。

被锁约束的一方不得持有覆盖开关，否则锁等于建议——而操作员打开这个档位，恰恰是因为需要它真的拦得住。覆盖权只在操作员侧（Decision 4 的两条路径）。

### 6. 新 kind 与分类

撞上占用 → typed 拒绝，`kind === "worktree_claimed"`，回执含**占用者会话 id** 与**释放路径**。

该 kind 进可恢复性分类表并归 `operator_required`——模型解不了别人的占用，因此回执自带停止指令，不得让模型重试。

### 7. 归属告知与本档位解耦

`enter-task-worktree` 成功回执告知「这棵树由会话 X 创建」是**恒定开**的：零成本（一次文件读）、永不阻塞、不受任何设置控制。

告知与拦截是两件事：告知让共用成为**知情**的决定，拦截让共用成为**被禁止**的决定。操作员可以只要前者（默认档），也可以两者都要（ON 档）。

## 已知限制

- **L1 枚举范围**：占用判据依赖枚举现存会话记录，其入口与成本**未验**（spec Open Questions 1）。若代价过高而退回「只查当前 hub 已加载的会话」，语义**弱一档**：跨进程 / 跨 hub 的占用看不见，两个独立 CLI 进程可同时 enter 同一棵树而互不拦截。退回时必须在设置项文档、回执文案与 spec 三处显式写明，**不得**让操作员以为拿到了跨进程排他。
- **L2 并发 TOCTOU**：占用来自持久化记录，而记录在「工具成功 + 会话保存」时才写。两个会话在同一时间窗内 enter 同一棵尚无记录指向的树，可能都读到「无占用」而双双成功。本 ADR **不解决**——解决它需要锁文件或注册表，与 Decision 3 冲突。要求该窗口被测试**钉住行为**（而非假装互斥）并在文档写明；L1 的枚举越全，窗口越窄。

## Why not

- **Why not 排他作为默认档**：会堵死「新会话接手旧树继续任务」这条正当且常用的工作流；且默认档变更是全档位语义变更，代价与 ADR-0037 §9.1 的围栏反转同级，而收益只对少数多会话并行场景成立。
- **Why not 活性检测（PID 探活 / 心跳 TTL）**：PID 探活有进程号复用与 serve 跨机失效；心跳要每会话一个定时器，是新机制新状态面。两者都是**不能保证可靠**的机制，而 Decision 4 已用既有 restart-safe 设计覆盖同一需求，零成本。
- **Why not 新增 `release` 命令**：它的唯一独立价值是「解绑但保留会话记录」，而 Decision 4 的主路径（恢复会话 + 自己 exit）已经能不丢历史地解绑。将来若真的出现「为放开一棵树而不得不删掉想留的历史」并且觉得痛，再补；形状已想清（只改绑定记录、不动树、不动未提交改动），不会返工。
- **Why not 锁文件 / 占用注册表**：见 Decision 3——引入跨进程共享状态就重新引入僵尸失效面。
- **Why not 用 owner sidecar 当授权**：见 Context 末段；且 sidecar 归属反演是纯路径/文件推导，`enter-task-worktree` 刻意不查它，改查会同时破坏 ADR-0037 Amendment 2026-08-30 的「含他人树」语义。

## Consequences

### Positive

- 需要归属隔离的操作员有一个真的拦得住的档位；不需要的操作员零变化（OFF 档字节不变）。
- 零新持久状态 ⇒ 零僵尸失效面；释放是 `exit` 的自动后果，不是需要维护的机制。
- 与归属告知正交组合：默认档也能把共用变成知情决定。

### Negative / Trade-offs

- ON 档下 A 崩溃未 exit 时，B 被拒；恢复需要操作员介入（恢复 A 会话或删除其记录）。这是显式 opt-in 档位所接受的成本。
- L1 / L2 是真实语义缺口，必须随实施一并写进文档，否则操作员会高估这把锁的强度。
- 新增一个设置项即新增一档组合状态（`worktreeOnMutate` × `worktreeExclusive`），测试矩阵相应增加。

### Reversibility

- 开关 OFF 即完整还原今日行为；已产生的 typed 拒绝不留任何持久痕迹（Decision 3）。
- 移除该档位只需删设置项与一道前置检查；`worktree_claimed` kind 与表中一行可同批移除，无迁移。

## Evidence

- enter 四道检查无归属：`src/session-api/worktree-rebind.ts:896-944`。
- restart-safe adoption 与 `initiallyBound`：`worktree-rebind.ts:790-798`、`src/harness/isolation/worktree-gate.ts:913`。
- 值域纪律参照：`src/config/settings.ts:223-226`（`worktreeOnMutate`）、`:299-303`（单读点 `resolveWorktreeOnMutate`）。
- 幂等 re-enter：`worktree-rebind.ts` `if (current === target) return target`。
