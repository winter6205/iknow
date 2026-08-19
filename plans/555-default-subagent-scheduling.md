# Plan: 555 — default-path spawn guidance (tool description SSOT)

**Goal:** 默认路径上，主代理只从 `spawn_subagent` 工具 description 学会何时/如何派子代理；生产装配不再往 `deps.system` 注入 coordinator 调度段。真任务验收（pipe / throwaway）仍记在 GitHub issue，不在本 plan 落地代码。

**Architecture:** 调度策略的唯一生产落点 = ACI 工具 `description`（模型在 tools 列表里看到的那串）。`coordinatorText` 装配缝保留（显式传入仍渲染），但 `buildHarnessEngine` 默认路径不再传入正文。Schema / handler / wait 默认 / 并发 cap **本 plan 不动**。角色 catalog / `role` 参数是 [#556](https://github.com/winter6205/iknow/issues/556)，禁止在本 plan 预埋。

**Tech Stack:** 现有 TypeScript harness（vitest）。无新依赖。

**Spec link:** none（operator skip-spec；决议在 [#555](https://github.com/winter6205/iknow/issues/555) 评论，gh-22 五节见下）。

**Tracker:** GitHub `ready-for-agent`（每 tracer bullet 一票；blocking 见 Cross-references）。

**Worktree:** 实施在独立 git worktree，不要在主 checkout 默认分支上改。

---

## Skip-spec Resolution (gh-22)

### Problem

#361 / ADR-0014 用「工具 description + 系统 coordinator 段」双写引导。系统段与工具重复，且仍写「异步是 future」。Claude Code 默认路径用 description 路由，不把调度写进主会话 system。#555 要证明默认 spawn 在真任务可用；先把引导落点改对，否则真任务测的是过时双写。

### Solution

生产默认：只改工具用法文案 + 停掉系统段注入。字段不删。嵌套 spawn 只靠代码禁，不写进 description。

### Implementation Decisions

1. 执行代理必须 **打开当时工作树里的源文件**（`grep` / 读 `createSpawnSubAgentTool` / `buildHarnessEngine`），禁止把本 plan 或聊天里的例句当成要粘贴的终稿。
2. description 主题以 [#555](https://github.com/winter6205/iknow/issues/555) 评论为准（何时派、阻塞/并行、`wait:false`、无 envelope 不谎报）；**不要**写嵌套禁止。
3. `IKNOW_ASSEMBLY_ORDER` / `coordinatorSegment` 缝保留；只停生产注入。常量若变成零引用，在同一颗停注入的 commit 里删掉，不要留死文案当第二 SSOT。
4. ADR-0014 决策 3/6 把 proactive 钉在 **system messages**。本 plan **覆盖引导落点**（改到 tools[].description），不覆盖 `wait:true` 默认。落盘 ADR 正文不在本 plan（`domain-modeling`）。

> Contradicts ADR-0014 decision 3/6 (system-slot guidance + trace keywords on messages) — worth reopening because operator 555 cut: Claude Code default = description routing, no dual-write.

### Testing Decisions

测试钉 **运行时工具对象的 `description`** 和 **默认 `deps.system()` 不含 coordinator 标题**，不钉本 plan 里的字符串。单测发现场装配，不复制一份「期望全文」到 plan。

### Out of Scope

- `role` / explore / general-purpose / 用户 agents 目录（#556）
- graph / 事件唤醒 / coordinator 模式
- 改 schema、handler、`wait` 默认、cap 4
- 真 LLM pipe 验收（#555 关票条件；本 plan 完成后由 operator 跑）
- TUI 面板（交互后补）
- 改 ADR 文件

---

## How to execute (anti-blind-follow)

实施会话开始时：

1. `git rev-parse --show-toplevel` 确认在 worktree。
2. `rg coordinatorText IKNOW_COORDINATOR spawn_subagent description` 于 `src/` `tests/`，以 **当时命中** 为 Affects 真值；下表路径是开工索引，不是行号合同。
3. 写测试时从 **现有** `tests/subagent/spawn-subagent.test.ts`、`tests/harness/identity/coordinator-segment.test.ts`、`tests/tui/deps-tools.test.ts`、`tests/harness/build-engine.test.ts` 改断言，不要对照本 plan 发明第二份文案。
4. 若代码已满足某条 Acceptance，跳过该 bullet 并在票上说明，不要为了「按 plan 改」而改回去。

---

## Architecture Change Reviewer verdict

```
bounded-context-guardian: yes — 只动 harness identity 注入与 spawn 工具文案；不新建顶层目录；不让 tui/cli import 新边。
defensive-contract-validator: yes — T1 钉 description 主题/禁嵌套句；T2 钉默认 system 缺席 coordinator、显式传入缝仍可用；空/未传 coordinatorText 既有用例保留。
error-handling-enforcer: N/A — 无新失败路径、不改 typed error。
complexity-anti-drift: yes — 删除或停用双写 SSOT，不增加调度分支。
minimal-change-verifier: yes — 每 bullet 一逻辑任务一 commit；#556 不混入。
```

---

## Tracer bullets

> Per-ticket loop：每个 `[implementation]` 必须含该行。

### T1. `[implementation]` spawn_subagent description = 工具用法 SSOT

- **Affects**: `src/harness/subagent/spawn-subagent-tool.ts`（仅 `description` 字符串）；`tests/subagent/spawn-subagent.test.ts`（及现有任何断言该 description 的测试——执行时 `rg description spawn-subagent` 确认）。不改 `inputSchema` / handler。
- **Acceptance**:
  1. 存在单测：读取 **工厂返回的** `description`（不要在测试里硬编码整篇期望稿去 `toEqual` 全文；用主题断言：何时用、阻塞或 same-turn、并行、`wait:false` / `subagent_result`、无 envelope 不谎报——用词以你读到的 issue 555 为准）。
  2. 同一 `description` **不**匹配嵌套禁令（执行时对工厂 `description` 断言不出现 `nested` / `one level` / `caps at` 这类嵌套政策；以测试为准）。
  3. `npx vitest run tests/subagent/spawn-subagent.test.ts` exit 0。
  4. `git diff --stat` 不含 schema/handler 行为文件，除非你发现 description 与注释同文件必须改注释——注释跟代码，不跟 plan。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Commit**: 1 commit = this task

### T2. `[implementation]` 默认路径停止注入 coordinator 调度段

- **Affects**: 执行时 `rg IKNOW_COORDINATOR_TEXT coordinatorText` 的 **生产** 调用点（预期含 `src/harness/build-engine.ts`）；`src/harness/identity/assemble.ts` 仅当常量变成零引用才删常量/注释；`tests/tui/deps-tools.test.ts`、`tests/harness/identity/coordinator-segment.test.ts`、以及任何「默认 system 含 proactively / Sub-agent coordination」的测试（`rg proactively tests/`）。
- **[blocks: T1]** — 先让工具文案成为 SSOT，再拆系统段，避免中间态「两处都没有引导」。
- **Acceptance**:
  1. 默认 `buildHarnessEngine`（`surface` 为 chat/tui/serve 且自建 manager）解析出的 `deps.system()` **不含** `## Sub-agent coordination`（单测；TUI `deps-tools` 同类断言改成缺席或改钉工具 description）。
  2. identity 缝：显式传入非空 `coordinatorText` 仍渲染该标题（保留 `coordinator-segment.test.ts` 的 seam 用例，可改用 **测试本地短字符串**，不要依赖生产调度稿）。
  3. `npx vitest run tests/harness/identity/coordinator-segment.test.ts tests/tui/deps-tools.test.ts tests/harness/build-engine.test.ts tests/subagent` exit 0。
  4. `npm run typecheck` exit 0。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Commit**: 1 commit = this task

### T3. `[implementation]` plan eval 钉结构，不钉文案

- **Affects**: `.evals/tasks/555-default-subagent-scheduling-plan.yaml`（本 bullet 新增）。
- **[blocks: T2]**
- **Acceptance**:
  1. `test_command` 只做结构检查，例如：生产 `build-engine`（或当时注入点）不再把 `IKNOW_COORDINATOR_TEXT` 传入 `coordinatorText`；`spawn-subagent-tool` 仍导出带 `description` 的工具。**禁止**在 yaml 里粘贴 description 全文。
  2. `bash .evals/run.sh --task 555-default-subagent-scheduling-plan` exit 0。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Commit**: 1 commit = this task

---

## Cross-references

- architecture-change-reviewer verdict: 见上（all yes / N/A）
- affected S1-S6: S2 测试改钉；S6 三 commit；不碰 S1 切片
- parallelization: 无 `[parallel]`；T1 → T2 → T3
- parent issue: [#555](https://github.com/winter6205/iknow/issues/555)
- tracer tickets: [T1](https://github.com/winter6205/iknow/issues/557) → [T2](https://github.com/winter6205/iknow/issues/558) → [T3](https://github.com/winter6205/iknow/issues/559)
- next catalog: [#556](https://github.com/winter6205/iknow/issues/556)
- live verify after T3: pipe + throwaway，见 555 票；本 plan 不写 prompt 全文
