# Spec: git 作业 — bash 侧效应链 + 四入口纪律段

> 重放 #863 到当前 master 装配缝。术语 persist 于 `docs/CONTEXT.md`。隔离语义以现行 CONTEXT **worktree isolation mode**（model-provision：门禁从不自动建树，模型调 `create-task-worktree`）为准，本文件不复述过期 auto-provision 文案。

## Glossary（exact copy from docs/CONTEXT.md）

- **git 作业**: 主代理用 `bash` 完成的版本库侧效应链（工作区变更 → add → commit，可选 push），不单独注册 ACI 工具。纪律段挂四入口、不进 worker；ask 不装配工作树工具。
  _Avoid_: git ACI 工具；`git_commit` / `git_push`；把环境现势当作业面；让只读子代理提交
- **worktree isolation mode**: 见 `docs/CONTEXT.md` 现行定义（ADR-0037 model-provision）。本 spec 不另写隔离 glossary。
- **ACI tool set**: 见 `docs/CONTEXT.md`。本轮不新增 git ACI 工具。

## Assumptions（CONTEXT 已锁定）

1. 不在 ACI 外另起 git 工具套件；不新增 `git_commit` / `git_push` 等 ACI 工具。
2. `bash` 默认模式可跑 mutating git；只读 bash 白名单不含 commit/push。
3. 隔离开关默认关；打开后主仓 mutate 拦下且须模型先调 `create-task-worktree`。本轮不改 `src/harness/isolation/worktree-gate.ts` git 层、不让隔离门禁自动建树。
4. 默认网络隔离；远端需 `network: true` 并走既有网络批准。本轮不改 permission 内建规则。
5. 四入口（chat / tui / serve / ask）都注入纪律段；ask 不装配工作树工具、不挂 mutate 门禁。
6. worker 不注入该纪律段；explore 只读 bash 拒 commit/push；general-purpose 仍可 bash mutating git；worker 工具面无工作树三件。
7. 环境现势不进模型消息（给人看仓，不进作业面）。
8. 纪律段是加性段：不重排 LOCKED 六段 `identity → soul → usage → user_profile → bootstrap → memory_layer`。
9. 段缺席不得用空串占位（不写空 system；KV 缓存字节级稳定）。
10. 标题为 `## Git work`，置于 `projectPathSegment` 之后、skills 之前；不替换、不改名既有 `## Git` 快照段。
11. Tech stack：既有 TypeScript / vitest；零新依赖。
12. 执行面仍是 bash；SOP 不进 bash handler；不复制第二套 git runner。
13. 不把环境现势灌进模型上下文；不改 `src/harness/env-snapshot.ts`；不做 PR / 远端托管产品闭环。

→ 以上视为已确认。

## Objective

主代理按纪律用现有 `bash` 完成 git 作业（工作区变更 → add → commit，可选 push）。契约钉死：执行面 bash、隔离走现行 model-provision、ask 与 worker 边界。成功 = SC 全绿。

## Boundaries

- **Does:**
  - 新增 identity 加性纪律段（单段不可变常量 + 渲染函数），经 `createIknowSystemResolver` / `assembleIdentityContext` 注入。
  - chat / tui / serve / ask 四入口（`buildHarnessEngine`）装配该段。
  - worker（`createWorkerDeps`）不传该段 gate → 段缺席。
  - 段正文覆盖：隔离关则在 cwd 用 bash 做 add/commit；隔离开则先 `create-task-worktree` 再提交；push 必须 `network: true` 并等批准；禁止 `commit --no-verify` 与 force push；写仓 git 不得派给只读子代理。
  - 现状页写明 git 作业走 bash + 纪律段；未实现节不把「完全不能 git」当作缺口。
- **Confirms with human:** （无。）
- **Out of this spec:** 新增 git ACI 工具；新建 git 模块 / 第二套 git runner；改 `src/harness/permission/policy.ts`；改 worktree-gate git 层；改 env-snapshot；ask 接线工作树工具；隔离门禁自动建树；PR / 远端托管产品闭环。

## Success Criteria

1. 契约文件存在且写明：不新增 git ACI 工具；四入口都注入纪律段；ask 不装配工作树工具；worker 不注入该段；本轮不改 permission 内建规则；环境现势不进模型消息。`specs/README.md` 活跃表有一行。
2. ask 与 chat 经 `createIknowSystemResolver` + `gitWorkDiscipline: true` 的装配产物都含段标题与 SC 正文要点（隔离关 cwd bash add/commit；隔离开先建树；push `network: true`；禁止 `--no-verify` 与 force push；不派只读子代理写仓）。
3. 段缺席（gate 未传 / false）→ 不追加空串；输出与基线字节级一致；不因缺席写空 system。
4. `IKNOW_ASSEMBLY_ORDER` 仍为六段 LOCKED 顺序（identity / soul / usage / user_profile / bootstrap / memory_layer）；加性段不重排。
5. 同一常量被两次装配调用得到相同正文（无共享可变状态）。
6. 同一轮夹具里父会话 system 含作业段、worker system 不含（`Promise.all` 并行装配不串段）。
7. explore 路径 `bash git commit` 仍 typed 拒绝（`ReadonlyViolationError`）。
8. worker 注册表无名 `create-task-worktree`（inner + promptTools）。
9. `docs/STATUS.md` 已实现节有一行说明主代理 git 作业走 bash + 纪律段；未实现节不把「完全不能 git」当作缺口。
10. `npx vitest run tests/harness/identity/git-work-segment.test.ts tests/subagent/git-work-discipline.test.ts` EXIT 0；既有 LOCKED 顺序测试仍绿。

## Open Questions

(none)

## Inherits / Changes

- Inherits：`specs/196-identity-assembly.md` 加性段模式（缺席 → 字节级零变化）；ADR-0037 worktree isolation（现行 CONTEXT / model-provision）；只读 bash 白名单（`ReadonlyViolationError`）；`createDefaultAciRegistry` 工作树三件条件化装配（host 缝缺席不入表）。
- Inherits：术语 SSOT `docs/CONTEXT.md` **git 作业**；plan `plans/git-work.md`。
- Changes：identity 装配加 `gitWorkDiscipline` gate + 常量段；`build-engine` 四入口传 true；worker 不传；STATUS 已实现表一行。
- Test command: `npx vitest run tests/harness/identity/git-work-segment.test.ts tests/subagent/git-work-discipline.test.ts`
- Surfaces: chat / tui / serve / ask 挂段；worker 不挂；ask 仍不装配工作树工具。

## ACR

```
bounded-context-guardian: yes — 纪律段只进 identity 装配；执行仍走 bash；隔离仍走既有工作树工具与 worktree 门禁；ask 四入口都挂纪律段，但不装配工作树工具、不挂 mutate 门禁；本轮零改 permission 与新 bounded context。
defensive-contract-validator: yes — empty：纪律段缺席不写空 system。negative：只读 worker git commit 拒绝。overflow：正文是单段常量，不因变长拆第二段或截断成半句。concurrent：段正文不可变、无共享可变状态（N/A: pure）；父会话与 worker 并行装配互不串段。exception：只读/工作树失败 typed 非空。
error-handling-enforcer: yes — 不新开错误族；bash / 只读 / 工作树失败继续走既有 ToolExecutionError、ReadonlyViolationError、WorktreeIsolationError；纪律段缺席不得用空串占位。
complexity-anti-drift: yes — SOP 不进 bash handler；加性段不重排 LOCKED 六段；不新增 git_* 工具、不复制第二套 git runner。
minimal-change-verifier: yes — 本 replay 为 1 个逻辑 commit（T1–T4 同轮落地）。
```

## 待写入

（空 — **git 作业** 已 persist）
