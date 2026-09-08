# Plan: worktree 占用锁（可选档位）

**Goal:** 需要归属隔离的操作员有一个真的拦得住的档位；不需要的操作员零变化（OFF 档 enter 行为逐字节不变），且这把锁不引入任何新的持久状态与僵尸失效面。

**Approach:** ADR-0070 与 CONTEXT「占用（worktree claim）」词条已在 specify 阶段落盘。第一步必须先答 spec 的 Open Question 1——**枚举现存会话记录的入口与成本**，因为它决定占用判定的语义强度（强档 = 全量枚举 / 弱档 = 只查当前 hub 已加载的会话），而语义强度决定要不要触发 L1 的三处强制披露。设置项与单读点可以和这个 spike 并行铺开（它不受强度决定影响）。检查本体与 `worktree_claimed` 落表在两者之后；最后把 L1/L2 两条已知限制钉进测试与文档，不让操作员高估锁的强度。

**Spec link:** `specs/worktree-exclusive-lock.md`
**ACR:** PASS（5/5 yes，与 `specs/write-situation-disclosure.md` 联合受审，见下方五维）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch；全部 bullet 落地后再跑一轮 `code-review`。

**Tracker:** 操作员明确不开 GitHub ticket，本 plan 的 T1–T4 不拆成 issue；依赖图以本文件的 `[blocks:]` / `[parallel]` 标注为唯一事实源。上游 [#946](https://github.com/winter6205/iknow/issues/946) 由 PR #947 关闭。

**跨 plan 依赖（硬约束）:** T3 要把新 kind `worktree_claimed` 落进可恢复性穷尽表，而该表由 `plans/write-situation-disclosure.md` **T7** 新建（`isolation/recoverability.ts`）。因此本 plan 的 T3 必须排在那份 plan 的 T7 之后。T1 / T2 / T4 不受此约束。

**合并顺序——已解除:** PR #947 已于 2026-09-08 合并（`4912fdd7`），本 plan 与 `plans/write-situation-disclosure.md` 的 commit 已 rebase 到其上、**零冲突**，doc 面共存已验证（详见那份 plan 头部的「合并顺序」段）。bullet 可立即开工，唯一仍然生效的顺序约束是上面那条**跨 plan 依赖**（T3 排在 disclosure T7 之后）。

## ACR

```
bounded-context-guardian: yes — boolean 值域留 config（settings.ts:223-226 / :299-303 同款单读点，不读 git、不持会话状态，ADR-0037 §5）；占用判定留 session-api（worktree-rebind.ts 本就 import 并 throw WorktreeIsolationError，:890 实证）；kind 与分类表留 isolation。
defensive-contract-validator: yes — 五类表全部分配、无造假：concurrent 要求测试钉住 TOCTOU 双成功而非假装互斥；exception 禁静默当无占用；overflow 覆盖多记录与路径归一化；empty 覆盖记录缺字段。
error-handling-enforcer: yes — 新 kind typed 而非布尔返回、进穷尽表拿停止指令；SC7 禁新增写盘路径；exception 臂显式禁 fail-open；「记录缺 workspaceRoot → 放行」不是 fail-open；L1/L2 写成显式已知限制。
complexity-anti-drift: yes — 一道前置检查 + 一个 boolean 设置 + 表里一行；不新增状态机、不新增持久结构、不改 gateMutate；SC8 禁 force 参数。
minimal-change-verifier: yes — 本份加新策略档位（默认档逐字节零回归），disclosure 份修既有行为可信性；合并会把 bug-fix 与新 feature 混进一个 commit；依赖已声明实施顺序，非环。
OVERALL: PASS — hand to writing-plans
```

## 待写入

（空 — ADR-0070 与 CONTEXT「占用（worktree claim）」新词条已在 specify persist flush。T1 的产出含 spec L1 段的更新，属 spec 文件本身，不是 CONTEXT/ADR 项。）

## Tasks (ordered by dependency)

1. **答 OQ1：会话记录枚举的入口与成本** — tag: `[decision]`
   - **Inherits:** spec Open Questions 1「实施第一步必须先答这个，因为它决定 SC3 的语义强度与 L1 是否触发」；已知限制 L1 的三处强制披露义务（设置项文档 / 回执文案 / spec）
   - **Surface:** `session-api`（会话记录的持有方）；产出是**决定 + `specs/worktree-exclusive-lock.md` L1 段的更新**
   - **Acceptance:** 明确回答三件事——(a) 枚举现存会话记录走哪个入口（`hub` recents / sessions 是否有现成索引、跨 root 怎么算）；(b) 单次 enter 的枚举成本量级，与「一次 git 子进程」比较；(c) 据此判定**强档**（全量枚举，跨进程占用可见）或**弱档**（只查当前 hub 已加载的会话）。判弱档时 L1 的三处披露文字必须同时写定，且 spec L1 段更新为已决状态；判强档时 L1 标为不触发并记录成本依据
   - **Decision (2026-09-08):** **弱档**。入口 = `SessionStore.list()`（`src/session-api/store/session-store.ts:515-534`），单进程单根命名空间。成本量级 ~10ms（N=10，file-read 主导），**远低于一次 git 子进程**；但跨进程 / 跨 CLI 占用看不见仍是不可避免的（需扫 `<dataDir>/sessions/*` 全部项目命名空间，量级到 M×N，本 spec 不做）。spec L1 段 + OQ1 段已更新为已决状态，T1 bullet 关单
   - Status: [x] done
   - [blocks: T3]

2. **设置项 `isolation.worktreeExclusive` + 单读点 + 装配期透传** — tag: `[implementation]`
   - **Inherits:** spec SC1、SC2；ADR-0070 Decision 1；ADR-0037 §5「开关只在启动加载点读取一次；config 层不读 git、不持会话状态；改绑不隐式重载 settings」；`worktreeOnMutate` 的值域纪律（`settings.ts:223-226` / 单读点 `:299-303`）
   - **Surface:** `src/config`（设置项 + 单读点）+ `src/harness/build-engine.ts`（装配期读取并透传）+ 既有 settings 测试
   - **Acceptance:** boolean-only；缺失 / 非 `true` 一律按 OFF（fail-closed，与 `resolveWorktreeOnMutate` 同款形状）；只在启动加载点读一次，改绑不触发 settings 重载；**OFF 档 `enter-task-worktree` 行为与今日逐字节一致**（断言锁死：四道检查不变、不新增任何拒绝路径）
   - Status: [ ] pending
   - [parallel]

3. **enter 前置占用检查 + `worktree_claimed`** — tag: `[implementation]`
   - **Inherits:** spec SC3、SC4、SC5、SC6、SC7、SC8、SC10；ADR-0070 Decision 2/3/5/6；CONTEXT「占用（worktree claim）」词条；输入五类表 empty / negative / overflow / exception 四臂
   - **Surface:** `src/session-api`（enter 缝的前置检查 + typed 抛出）+ `src/harness/isolation`（`WorktreeIsolationErrorKind` 加成员；`recoverability.ts` 加一行 `operator_required`）+ 相应测试
   - **Acceptance:** ON 档 + 目标树被别的现存会话记录占用 → typed 拒绝 `kind === "worktree_claimed"`，回执含**占用者会话 id** 与**释放路径**（恢复那个会话让它自己 `exit-task-worktree`，或删除该会话记录），并因归 `operator_required` 而自带停止指令；ON 档 + 无占用 → enter 照常成功；**自占用不算占用**（幂等 re-enter 返回同一根、零写）；记录缺 `workspaceRoot` 或字段空串 → 视为无占用放行（不 throw）；记录读取抛非 ENOENT I/O → 原样 rethrow 或 typed fail-closed，**绝不**静默当成无占用；`enter-task-worktree` 的 `inputSchema` **未新增**任何覆盖 / 强制字段；本 bullet 的 diff **不新增任何写盘路径**（审查项）；SC10 交叉验证——`plans/write-situation-disclosure.md` T9 的归属告知在**本开关 OFF 档同样生效**（两特性互不为前提）
   - Status: [ ] pending
   - [blocks: T1, T2；跨 plan blocks: `plans/write-situation-disclosure.md` T7]

4. **L2 TOCTOU 行为钉住 + L1 披露落三处** — tag: `[implementation]`
   - **Inherits:** spec 已知限制 L1 / L2；输入五类表 concurrent 臂「按 L2 写明：允许双双成功，但必须有测试**钉住这个行为**，不得假装互斥」；ADR-0070「已知限制」段
   - **Surface:** `src/session-api` 测试 + 设置项文档 + 拒绝回执文案 + `specs/worktree-exclusive-lock.md`
   - **Acceptance:** 有一条测试**钉住** L2 行为——两个会话在同一时间窗内 enter 同一棵尚无记录指向的树，双双成功（断言这是**已知行为**而非缺陷，测试名与注释点明 TOCTOU）；若 T1 判弱档，L1 的披露在**三处**同时在场（设置项文档 / `worktree_claimed` 回执文案 / spec），且措辞明确说明跨进程占用看不见，不得让操作员以为拿到了跨进程排他
   - Status: [ ] pending
   - [blocks: T3]

## 明确不做（不是 bullet，实施时不得顺手加）

`force` 或任何覆盖参数（SC8）· `release` 命令 · 活性检测（PID 探活 / 心跳 TTL）· 锁文件 · 占用注册表 · 跨调用存活的内存 Map · 把排他变成默认档 · 用 owner sidecar 当授权（sidecar 只负责告知）· 把占用与「写处境」告知耦成同一个开关。理由全部见 ADR-0070「Why not」段。

## 收尾

全部 bullet 落地后跑一轮 end-of-round code review（`arthurpower:code-review` 双轴），再 `verification-before-completion` 对照 spec SC1–SC11 逐条核对。绿线：`npm test` + `npm run typecheck` exit 0。新增一个设置项即新增一档组合状态（`worktreeOnMutate` × `worktreeExclusive`），测试矩阵相应增加——这是 ADR-0070 已认下的 trade-off，不是 scope creep。
