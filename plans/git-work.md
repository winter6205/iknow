# Plan: git 作业

**Goal:** 主代理能按纪律用现有 `bash` 完成工作区变更 → 暂存 → 提交，可选推远端；不新增 git ACI 工具。
**Approach:** 把 #863 能力重放到当前 master 装配缝（`assemble.ts` / `build-engine.ts`）。隔离语义跟现行 CONTEXT model-provision，不 rebase `winter/git-work-plan-a483`。
**Spec link:** `specs/git-work.md`
**Tracker:** 本地 markdown。T1–T4 即本 replay，不挂 GitHub issue。
**ACR:** all-yes（见 spec）。

## Tasks (this replay)

1. **钉死 git 作业契约** — tag: `[decision]` — Status: [x] this replay
2. **四入口挂 git 作业纪律段** — tag: `[implementation]` — Status: [x] this replay
3. **worker 不注入作业段，只读面仍拒写仓 git** — tag: `[implementation]` — Status: [x] this replay
4. **现状页写上 git 作业** — tag: `[implementation]` — Status: [x] this replay

## 本轮明确不做

- 不新增 `git_commit` / `git_push` 等 ACI 工具
- 不新建 git 模块、不第二套 git runner
- 不改 permission 内建规则、worktree-gate、env-snapshot
- 不让隔离门禁自动建树
- 不给 ask 接线工作树工具
- 不 merge / rebase `winter/git-work-plan-a483`，不关 PR #863
