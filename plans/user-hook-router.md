# Plan: 用户钩子同进程 router

**Goal:** 用户钩子三条 deny-only 事件可经 `settings.hooks` 默认关启用；内置钩子与自动记忆等产品开关不被钩子总闸关掉。
**Approach:** 先能解析 settings，再做同进程 router（PreToolUse + 组合器），然后并行接 PreWrite / PreCommit，最后挂进 build-engine 并钉正交回归。不扫 hooks 目录、不加 TUI 面板。
**Spec link:** `specs/user-hook-router.md`
**ADR:** `docs/adr/0055-user-hook-router.md`（本轮 persist 已落盘，无独立 `[decision]` 子弹）
**ACR:** all-yes（见下）
**Tracker:** fallback — 本工作树只交 spec/plan 文件；未在本回合创建 GitHub `ready-for-agent` issue（避免在未授权 push 的功能分支上批量开票）。需要 tracker 时按 `writing-plans/references/tracker.md` 补。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入

空 — CONTEXT 五词 + ADR-0055 已在 SPECIFY persist 刷过。

## ACR

bounded-context-guardian: yes — Boundaries/Changes land a capability `src/harness/hooks/` factory (ADR-0045 in-process) composed into the existing 5-step Pre slot; Out-of-spec forbids Policy-server merge, `auto-hook.ts` move, and `settings.hooks` owning builtin.
defensive-contract-validator: yes — Success Criteria allocate empty (SC1 `enabled` 缺席), negative (SC3/SC4 未命中放行), overflow (SC10 stringify 截断), concurrent (SC9 Post+Pre 同在 + multiplexer 先拦先赢/SC5), exception (SC6 非法 pattern + `onHookError`).
error-handling-enforcer: yes — Inherits fail-closed Pre / fire-and-forget Post and `hook_blocked`/`hook_error` prefixes; SC6 construction-time discard is non-empty and does not poison the tool surface; SC10 forbids uncaught overflow.
complexity-anti-drift: yes — Changes declare `createHookServer` → `{ pre, post }` plus two hook sources, reuse `classifyCall` for PreWrite, and keep PreCommit as a separate git detector; Out-of-spec rejects a single Policy god-file and a 6th permission step.
minimal-change-verifier: yes — Objective/Changes is one capability (user hooks router + compose + persist) with Out-of-spec holding memory/secrets/graph; writing-plans may sequence multiple commits (settings vs factory vs mount vs docs) rather than one commit for the whole spec.

## Tasks (ordered by dependency)

1. **Parse `settings.hooks`（user hooks only）** — tag: `[implementation]`
   - **Inherits:** spec SC1；ADR-0015 非法字段丢弃；`enabled` 缺席=关；`rules[]` 为 V1 启用集，无 `allow[]`；禁止把 builtin / memory / secrets 段改挂到 `hooks`
   - **Surface:** `src/config`（settings 单承载）
   - **Acceptance:** 合法 `hooks` 段深冻结进 merged settings；缺席/非法不抛且不产出 enabled=true；user 与 project 覆盖纪律与现有 llm/secrets 段一致
   - Status: [ ] pending

2. **Hook router：contribution + multiplexer + PreToolUse 规则** — tag: `[implementation]`
   - **Inherits:** spec SC2/SC5/SC6/SC10；#126 deny-only Pre、fail-closed、stringify 截断；坏 pattern 构造期剔除
   - **Surface:** 新能力模块 `src/harness/hooks/`（工厂名实施自定）；permission 类型仍是挂载面
   - **Acceptance:** enabled 时命中规则 → `[hook_blocked]` + reason；未命中放行；多规则先拦先赢；非法正则不拦死全工具面；超长 input 不抛未捕获异常
   - Status: [ ] pending
   - [blocks: T1]

3. **[parallel] PreWrite 事件（复用 classifyCall）** — tag: `[implementation]`
   - **Inherits:** spec SC3；mutate SSOT = `classifyCall` / `FILE_WRITE_TOOL_NAMES`；不是第 6 步
   - **Surface:** `src/harness/hooks/` 消费 isolation 的 classify，禁止反向依赖把 isolation 推进 hooks
   - **Acceptance:** mutate 调用可被 PreWrite 规则拦；`read_file` 等非 mutate 不因 PreWrite 被拦
   - Status: [ ] pending
   - [blocks: T2]

4. **[parallel] PreCommit 事件（git commit 形态）** — tag: `[implementation]`
   - **Inherits:** spec SC4；第一个非 option 子命令为 `commit`；不是 JSONL commit hook
   - **Surface:** `src/harness/hooks/`
   - **Acceptance:** `git commit` / `git -C <path> commit` 可拦；`git status` 与 `git commit --help` 不拦
   - Status: [ ] pending
   - [blocks: T2]

5. **build-engine 内置+用户钩子装配** — tag: `[implementation]`
   - **Inherits:** spec SC8/SC9；builtin 代码挂上；user 仅 enabled 时编入；permission bypass 仍 deny；子引擎同一 merged settings；不覆盖 TUI Post
   - **Surface:** `src/harness` 装配（build-engine → createAciExecutor）
   - **Acceptance:** `secrets.mode=block` 时 guard 在 `hooks.enabled=false` 下仍在；TUI Post 与 user Pre 同在时观测仍触发、user deny 仍短路；child engine 吃同一 user rules
   - Status: [ ] pending
   - [blocks: T3, T4]

6. **产品开关正交回归** — tag: `[implementation]`
   - **Inherits:** spec SC7；ADR-0055 正交条款；`auto-hook.ts` 不迁入 hooks 模块
   - **Surface:** 既有 memory 装配测试 + hooks 装配测试
   - **Acceptance:** `hooks.enabled=false` 且 `memory.autoExtract=true` 时 auto-memory host 钩子仍按现约出现；既有 secrets roundtrip 默认路径测试不因 hooks 段缺席变红
   - Status: [ ] pending
   - [blocks: T5]

7. **Architecture 索引行** — tag: `[implementation]`
   - **Inherits:** spec Changes：`docs/architecture.md` Capability 表增加 Hook router；`specs/README.md` 本 worktree 已加点名
   - **Surface:** `docs/architecture.md`
   - **Acceptance:** Capability 表有 hook router 一行，职责写两类钩子 + 指向 spec/ADR-0055，不把 sandbox server 写成钩子实现
   - Status: [ ] pending
   - [parallel] 可与 T6 后或与 T5 后并行；[blocks: T2]

## Code review phase (end of round)

全部子弹落地后：Standards + Spec 双轴 `code-review`，再 `verification-before-completion`。
