# Plan: home 项目树（projects / sessions / tasks 错配收口）

**Goal:** 工作区 `.iknow` 不再承载会话记录、退役 `sessions/` 树、后台任务登记；三者按 `projectIdentityRoot` 落在 home 项目树（显式 `--data-dir` 除外）。
**Approach:** 合同先钉路径与冲突规则；再改 `tasksDir` 派生与装配；最后一次性挪走工作区三目录存量。不自动把旧 `sessions/` 变成会话文件夹。grep 排除 `.iknow`、#1003 正则/Node 扫面、`memory/` 搬家均不在本计划。
**Spec link:** LogicSync（本会话）+ ADR-0088；无独立 `specs/*.md`。
**ACR:** all-yes（2026-09-13）

```
bounded-context-guardian: yes — 落点仍在既有 harness background 与 session-api 池根公式内，不新开 bounded context，不把登记表塞进会话叶子。
defensive-contract-validator: yes — 路径派生覆盖空/缺 dataDir、显式 dataDir、相对路径拒绝（沿既有 WorkspaceRoot / dataDir 契约）、目标已存在不覆盖。
error-handling-enforcer: yes — 存量冲突 skip 不合并；缺 tasksDir 沿既有 stale-reap skip；产品路径对退役 sessions/ 零写入而非静默双读。
complexity-anti-drift: yes — 复用会话池 slug / dataDir 公式，tasks 只换锚不并行第二套树。
minimal-change-verifier: yes — 单任务「home 项目树」；不含 grep 排除表、不含 #1003。
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（落地收尾按操作员 commit 规则；本计划不规定一 bullet 一 commit）

**Affected (implementation, T2–T4):** `src/harness/background/paths.ts` 及调用方（`build-engine` / 装配）、对应 background 测试、存量挪盘脚本或一次性操作说明、`docs/STATUS.md` / `docs/architecture.md` 事实句。合同文件属 T1。

**Sibling:** #1003 搜面引擎 → `docs/plans/1003-grep-single-engine.md`。本计划不含那张票；排除 `.iknow` 仍不是 #1000 修法。

**待写入:** flushed 2026-09-13（ADR-0088 + CONTEXT + 0019/0021/0025/0071/0087/0037 amendments）。

## Harvest

**Settled**

- 池根 = 显式 `--data-dir` / `dataDir`，否则 `~/.iknow`（ADR-0087）。
- 分组键 = `projectIdentityRoot` slug（ADR-0071）。
- 会话记录已按该公式写 `projects/<slug>/<conversationId>/`。
- 后台登记是活状态，**不进** conversation 叶子；进同项目树兄弟 `tasks/`。
- 退役 `sessions/`：不写、不自动迁成会话文件夹（0071 L3 不变）。
- 冲突：目标已存在不覆盖。
- throwaway `--workspace-root` 不再隔离 transcript **也不再**隔离 tasks。

**Open for implementer (shape only)**

- `resolveTasksDir` 参数表如何接到既有 `(dataDir, projectIdentityRoot)`（不新发明第二套 slug）。
- 工作区存量是 `mv` 进 `~/.iknow/sessions/` 旧池还是 `~/.iknow/archive/…`，只要离开工作区且不覆盖。

## Tasks (ordered by dependency)

1. **合同：home 项目树** — tag: `[decision]`
   - **Inherits:** 上列 Settled；工作区 `.iknow` 只留必须贴 git 仓的锚。
   - **Surface:** `docs/adr/` + `docs/CONTEXT.md`
   - **Acceptance:** ADR-0088 accepted；0021 D1.3 / 0019 tasks 条款 / 0071 Decision 2 活状态锚 / 0087「tasks 仍 per-root」均指向 0088；CONTEXT 有 **home 项目树** 与 **后台任务登记**，`workspaceRoot` 不再列出 tasks。
   - Status: [x] done 2026-09-13

2. **tasksDir 跟会话池同一项目树** — tag: `[implementation]`
   - **Inherits:** ADR-0088：`…/projects/<slug>/tasks/`；`--data-dir` 同会话池；不跟 `workspaceRoot`。
   - **Surface:** harness background（paths + 装配）
   - **Acceptance:** 新 background task 的 json/log 不出现在 `<workspaceRoot>/.iknow/tasks/`；出现在池根下该 slug 的 `tasks/`。既有 conversation scope / stale reap / 进程退出 reap 语义不变。相关 vitest 绿。
   - Status: [ ] pending
   - [blocks: T1]

3. **工作区三目录存量离开 checkout** — tag: `[implementation]`
   - **Inherits:** 冲突不覆盖；`sessions/` 不自动变成 `projects/` 叶子；产品路径不再写 `<ws>/.iknow/{projects,sessions,tasks}`。
   - **Surface:** 一次性挪盘（操作员环境 + 若代码仍写 `sessions/` 则掐写）
   - **Acceptance:** 本仓（及文档点名的同类路径）工作区这三目录不再作为产品写点；残留要么空/删除，要么仅冲突 SKIP 叶子。新 TUI 回合与新 bg task 不在工作区这三处落盘。
   - Status: [ ] pending
   - [blocks: T2]

4. **现状文档跟代码同句** — tag: `[implementation]`
   - **Inherits:** ADR-0088 路径字面量。
   - **Surface:** `docs/STATUS.md`、`docs/architecture.md`（仅事实句，不另开 ADR）
   - **Acceptance:** STATUS / architecture 不再把 tasks 写成 `<workspaceRoot>/.iknow/tasks/`，也不把工作区 `.iknow/sessions` 写成现行会话池。
   - Status: [ ] pending
   - [blocks: T2]
   - [parallel] 可与 T3 并行（T3 不改文档字面也可先挪盘）

## Code review phase

全部 implementation bullets 落地后跑一轮 `code-review`；`GATE: BLOCKED` 则下一槽 `review-report-repair`，再 `verification-before-completion`。
