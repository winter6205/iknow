# Plan: git 作业

**Goal:** isolation ON 时主代理按纪律用 `bash` 完成工作区变更 → add → commit；不新增 git ACI 工具；远端不进 identity。
**Approach:** 纪律段绑定 `build-engine` 既有 `isolationEnabled`；ask / worker / isolation OFF 段缺席，OFF 不补教程。
**Spec link:** `specs/git-work.md`
**Tracker:** 本地 markdown。T1–T4 为 replay；本文件同时跟踪 isolation-ON + 无 push 收紧。不挂 GitHub issue。
**ACR:** all-yes（见 spec）。

## Tasks

1. **钉死 git 作业契约** — Status: [x]
2. **isolation ON 的 chat/tui/serve 挂纪律段** — Status: [x]
3. **worker / ask 不注入；只读面仍拒写仓 git** — Status: [x]
4. **现状页写上 git 作业** — Status: [x]
5. **收紧：system 无 push；gate = isolationEnabled** — Status: [x] this commit

## 本轮明确不做

- 不新增 `git_commit` / `git_push` 等 ACI 工具
- 不把 push / `network: true` / force-push 写进 identity
- isolation OFF 不追加「如何用 git」教程
- 不新建 git 模块、不第二套 git runner
- 不改 permission 内建规则、worktree-gate、env-snapshot
- 不给 ask 接线工作树工具
- 不 merge / rebase `winter/git-work-plan-a483`，不关 PR #863
