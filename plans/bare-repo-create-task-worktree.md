# Plan: bare repo 上 `create-task-worktree` 可建树

**Goal:** isolation ON 时，主仓是可用 git 仓（含 bare gitdir、以及 `core.bare=true` 但仍带工作文件的检出）时，`create-task-worktree` 能建 task worktree 并改绑；只有「没有可用 gitdir」才 `not_a_git_repo`，主仓零写入不变。
**Approach:** 先把「可用 git 仓」写进 ADR-0037（对齐已有 §6，纠正实现把 bare 误判成非 git）。再改建树前探针与门禁单测。最后用 hub provision 证明 ACI 逃生口在同一布局下能改绑、下一波 mutate 进新树。不关隔离开关，不改 `core.bare`，不静默写主仓。
**Spec link:** `docs/adr/0037-worktree-isolation-on-mutate.md`（门禁与 fail-closed）；`specs/task-worktree-lifecycle.md` 条款 6–8（建树改绑、当波不写、下一波重发）。无独立新 spec。
**Tracker:** none — 操作员明确不要 GitHub issue；本文件是切片 SSOT。
**Worktree:** `/home/winner/projects/iknow/.iknow/worktrees/bare-repo-create-task-worktree`（branch `fix/bare-repo-create-task-worktree`）。
**Evidence:** session `6c745347-003d-4d36-8042-8db55e40af8f`：`create-task-worktree` → `kind=not_a_git_repo`；随后 `write_file` / `bash` / `spawn_subagent` 被 `[worktree_isolation]` 拦住。本仓 `.git/config` `bare = true`，`rev-parse --is-inside-work-tree` 为 false。对照：同一布局下 `git worktree add -b` 成功。
**ACR:** all-yes（见下块）。
**待写入:** 无（不新增领域词；T1 只修订已有 ADR-0037 条款，不新开 ADR 号）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch。整轮结束后再跑 code-review（Standards + Spec），不在每个 bullet 重复。

## ACR

affects: `docs/adr/0037-worktree-isolation-on-mutate.md`
affects: `src/harness/isolation/worktree-gate.ts`
affects: `tests/harness/isolation/worktree-gate.test.ts`
affects: `tests/session-api/hub-worktree-isolation.test.ts`

bounded-context-guardian: yes — 探针仍在 harness isolation（建树 SSOT）；hub 只继续调用既有 provision 缝；不新建 context、不让 session-api 再探一次 git。
defensive-contract-validator: yes — T2 覆盖 empty（无 git 的空目录）、negative（非 git 仍 `not_a_git_repo`；有历史的 bare / `core.bare=true` 改为成功）、overflow（既有 `worktree_exists` / `branch_exists` 不改语义）、exception（git spawn → `git_unavailable`；无 commit 的空 bare → `worktree_add_failed`）；concurrent 仍由既有同会话幂等 provision 覆盖，本切片不新开并发面。
error-handling-enforcer: yes — 失败仍走 `WorktreeIsolationError` 既有 kind；探针失败 EXIT 仍是 typed 可见；禁止把建树失败改成写主仓。
complexity-anti-drift: yes — 只换「是否可用 gitdir」这一前置判定，不把 `worktree add` / 改绑 / 门禁分类揉进同一新抽象。
minimal-change-verifier: yes — 一件逻辑事（bare/usable gitdir 可建树）；切片按 writing-plans 拆 commit，不混隔离开关、spawn 分类、session status、也不改操作员的 `core.bare`。

> 不 contradict ADR-0037。§6 写的是「主仓**不是 git 仓库** / git 不可用 / 创建失败」fail-closed。现行探针把 `--is-inside-work-tree !== true`（含合法 bare）收成 `not_a_git_repo`，比 ADR 更窄。本计划是对齐 ADR，不是 reopen 门禁。

## Tasks (ordered by dependency)

1. **写明「可用 gitdir」合同** — tag: `[decision]`
   - **Inherits:** ADR-0037 §6：「主仓不是 git 仓库 / git 不可用 / 创建工作树 ACI 工具失败：mutate 一律被拦下并给出 typed、非空、可见的错误，不静默放行写主仓。」CONTEXT `worktree isolation mode`：建树失败与主仓非 git 仓库 fail-closed。
   - **Surface:** `docs/adr/` 既有 ADR-0037（amendment，不新开编号）
   - **Acceptance:** amendment 写清：`not_a_git_repo` 仅当该根没有可用 gitdir（`rev-parse --git-common-dir` 或等价探测失败）；bare gitdir 与 `core.bare=true` 但仍能 `git worktree add` 的检出是可用仓；空目录 / 非 git 仍 `not_a_git_repo`；git 二进制 spawn 失败仍 `git_unavailable`。本 commit 不改运行时代码。
   - Status: [ ] pending

2. **建树前探针与门禁单测对齐合同** — tag: `[implementation]`
   - **Inherits:** T1 的可用 gitdir 合同；`createTaskWorktree` 既有后续 EXIT（`branch_exists` / `worktree_exists` / `worktree_add_failed`）；主仓 HEAD 与当前分支不被 `-b` 拖动（既有硬要求）。
   - **Surface:** harness isolation（建树函数与其测试）
   - **Acceptance:** 无 git 的普通目录仍 `not_a_git_repo` 且零写入；有至少一次 commit 的 bare gitdir，以及 `core.bare=true` 且工作文件在该根的检出，`createTaskWorktree` 成功、新树可检出文件、来源仓 HEAD 不变；无 commit 的空 bare 为 `worktree_add_failed` 而非 `not_a_git_repo`。守卫命令：`npx vitest run tests/harness/isolation/worktree-gate.test.ts`。
   - Status: [ ] pending
   - [blocks: T1]

3. **hub provision 在同一布局下能改绑** — tag: `[implementation]`
   - **Inherits:** T1；ADR-0037 §1 / spec 条款 6–8：工具成功 = 树在且本会话已 rebind；当波被拦的写不执行；失败不改会话根。`specs/task-worktree-lifecycle.md` Success 所用命令包含 `tests/session-api/hub-worktree-isolation.test.ts`。
   - **Surface:** session-api hub 的 worktree provision 缝（不改 ACI 工具形状）
   - **Acceptance:** isolation ON 时，在 T2 那两类可用仓上 `provisionWorktree` 成功、会话根改到本会话 task worktree；对普通非 git 目录仍 `not_a_git_repo` 且会话 `workspaceRoot` 不变。守卫命令：`npx vitest run tests/session-api/hub-worktree-isolation.test.ts`。
   - Status: [ ] pending
   - [blocks: T2]

## Out of scope

- 把本仓 `core.bare` 改回 `false`（操作员绕过，不是产品修复）。
- 关掉 `settings.isolation.worktreeOnMutate`。
- ADR-0040：`spawn_subagent` 在 unbound 且 worker 带写工具时仍为 mutate。
- session record `status: ok` 与未完成 todo 不一致。
- 静默放行写主仓；自动 provision；改 `create-task-worktree` 入参形状。

## Code review phase (end of round)

三颗 bullet 都落地后：`code-review`（Standards + Spec）一次，对照本计划与 ADR-0037 §6，再 `verification-before-completion`。
