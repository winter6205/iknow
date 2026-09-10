# Spec: git 作业 — isolation ON 时的本地 bash 纪律段

> 重放 #863 后再按操作员裁决收紧：system 不含 push；段仅 isolation ON 的 chat/tui/serve。术语 persist 于 `docs/CONTEXT.md`。隔离语义以现行 CONTEXT **worktree isolation mode**（model-provision）为准。

## Glossary（exact copy from docs/CONTEXT.md）

- **git 作业**: 主代理用 `bash` 完成的版本库侧效应链（工作区变更 → add → commit），不单独注册 ACI 工具。纪律段仅在 worktree isolation ON 时挂 chat/tui/serve，不进 ask / worker；远端不进 identity。
  _Avoid_: git ACI 工具；`git_commit` / `git_push`；把环境现势当作业面；让只读子代理提交；把 push / network 写进 system
- **worktree isolation mode**: 见 `docs/CONTEXT.md` 现行定义（ADR-0037 model-provision）。本 spec 不另写隔离 glossary。
- **ACI tool set**: 见 `docs/CONTEXT.md`。本轮不新增 git ACI 工具。

## Assumptions（CONTEXT 已锁定）

1. 不在 ACI 外另起 git 工具套件；不新增 `git_commit` / `git_push` 等 ACI 工具。
2. `bash` 默认模式可跑 mutating git；只读 bash 白名单不含 commit/push。
3. 隔离开关默认关；打开后主仓 mutate 拦下且须模型先调 `create-worktree`。本轮不改 `src/harness/isolation/worktree-gate.ts` git 层、不让隔离门禁自动建树。
4. 远端 git 不进 identity；仍走用户授权 + 既有网络权限。本轮不改 permission 内建规则。
5. 纪律段仅 isolation ON 的 chat / tui / serve 注入；ask 即使传入 gate 也不注入（无工作树工具）。isolation OFF 段缺席，不补教程。
6. worker 不注入该纪律段；explore 只读 bash 拒 commit/push；worker 工具面无工作树三件。
7. 环境现势不进模型消息（给人看仓，不进作业面）。
8. 纪律段是加性段：不重排 LOCKED 六段 `identity → soul → usage → user_profile → bootstrap → memory_layer`。
9. 段缺席不得用空串占位（不写空 system；KV 缓存字节级稳定）。
10. 标题为 `## Git work`，置于 `projectPathSegment` 之后、skills 之前；不替换、不改名既有 `## Git` 快照段。
11. Tech stack：既有 TypeScript / vitest；零新依赖。
12. 执行面仍是 bash；SOP 不进 bash handler；不复制第二套 git runner。
13. 不把环境现势灌进模型上下文；不改 `src/harness/env-snapshot.ts`；不做 PR / 远端托管产品闭环。

→ 以上视为已确认。

## Objective

主代理在 isolation ON 时按纪律用现有 `bash` 完成 git 作业（工作区变更 → add → commit）。远端不进 system。成功 = SC 全绿。

## Boundaries

- **Does:**
  - 新增 identity 加性纪律段（单段不可变常量 + 渲染函数），经 `createIknowSystemResolver` / `assembleIdentityContext` 注入。
  - `buildHarnessEngine` 用既有 `isolationEnabled` 作为唯一判定源：ON 才传 `gitWorkDiscipline`；OFF 字段缺席。
  - ask 在 resolver 内挡掉（即使传入 flag）；worker（`createWorkerDeps`）不传 gate。
  - 段正文仅本地纪律：执行面 bash；有 `create-worktree` 则先建树再只在该树提交；禁止 `commit --no-verify` / `-n`；写仓 git 不得派给只读子代理。不含 push / network / force-push /「Isolation off」子弹。
  - isolation OFF 不追加替代教程段。
  - 现状页写明 git 作业走 bash + 条件纪律段。
- **Confirms with human:** （无。）
- **Out of this spec:** 新增 git ACI 工具；新建 git 模块 / 第二套 git runner；改 `src/harness/permission/policy.ts`；改 worktree-gate git 层；改 env-snapshot；ask 接线工作树工具；隔离门禁自动建树；把 push 写进 identity；PR / 远端托管产品闭环。

## Success Criteria

1. 契约写明：不新增 git ACI 工具；段仅 isolation ON 的 chat/tui/serve；ask / worker / isolation OFF 不注入；system 不含 push / network；环境现势不进模型消息。`specs/README.md` 活跃表有一行。
2. chat / tui / serve 经 `createIknowSystemResolver` + `gitWorkDiscipline: true` 含段标题与本地 SOP 要点；ask 即使传 true 也不含该段。
3. 段缺席（gate 未传 / false）→ 不追加空串、不补教程；输出与基线字节级一致。
4. `IKNOW_ASSEMBLY_ORDER` 仍为六段 LOCKED 顺序；加性段不重排。
5. 同一常量被两次装配调用得到相同正文。
6. 同一轮夹具里父会话 system 含作业段、worker system 不含。
7. explore 路径 `bash git commit` 仍 typed 拒绝（`ReadonlyViolationError`）。
8. worker 注册表无名 `create-worktree`（inner + promptTools）。
9. `docs/STATUS.md` 已实现节有一行：parent bash + identity 段仅 isolation ON；无 git ACI 工具；无 push 进 system。
10. `npx vitest run tests/harness/identity/git-work-segment.test.ts tests/subagent/git-work-discipline.test.ts` EXIT 0。

## Open Questions

(none)

## Inherits / Changes

- Inherits：`specs/196-identity-assembly.md` 加性段模式；ADR-0037 worktree isolation；只读 bash 白名单；工作树三件条件化装配。
- Inherits：术语 SSOT `docs/CONTEXT.md` **git 作业**；plan `plans/git-work.md`。
- Changes：`gitWorkDiscipline` gate 绑定 `isolationEnabled`；ask 永不注入；SOP 去掉远端。
- Test command: `npx vitest run tests/harness/identity/git-work-segment.test.ts tests/subagent/git-work-discipline.test.ts`
- Surfaces: isolation ON 的 chat / tui / serve 挂段；ask / worker / isolation OFF 不挂。

## ACR

```
bounded-context-guardian: yes — 纪律段只进 identity 装配；执行仍走 bash；隔离判定复用 isolationEnabled；ask 不挂段、不装配工作树工具。
defensive-contract-validator: yes — empty：缺席不写空 system。negative：ask 传 flag 仍缺席；只读 worker git commit 拒绝。overflow：单段常量。concurrent：正文不可变。exception：只读失败 typed。
error-handling-enforcer: yes — 不新开错误族；缺席不得用空串占位。
complexity-anti-drift: yes — SOP 不进 bash handler；不重排 LOCKED 六段；不新增 git_* 工具。
minimal-change-verifier: yes — 本收紧为 1 个逻辑 commit。
```

## 待写入

（空 — **git 作业** 已 persist）
