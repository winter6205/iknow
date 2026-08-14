# Plan: TUI 入口 subagent 接线清理（#365）

> **Issue**: [#365 TUI 入口 subagent 接线清理（#361 后续）](https://github.com/winter6205/iknow/issues/365)（wayfinder:task，pending）
> **Map**: wayfinder:map [#331 子代理能力 V1](https://github.com/winter6205/iknow/issues/331)（cleared 2026-08-10）
> **决议锚点**: T1 #130 / T2 #332 / T3 #333 / T4 #334 / T5 #335 + ADR-0014（前景 spawn 默认契约，2026-08-11）+ V1.5 #361 落地 PR #364
> **Tracker**: GitHub issues（`ready-for-agent` 标签）；`[blocks:]` 以本文件依赖图为真值，由 GraphQL `addBlockedBy` 渲染为 native blocking。
> **前置隔离**: 工作树若已有未提交改动，先 `git stash` 或单独提交；执行第一票前需 `git status` 干净。
> **范围**：本计划把 `buildTuiDeps` 切到 `buildHarnessEngine({surface:"tui"})` SSOT 上，让 TUI 自动继承 V1.5 的 subagentManager + `IKNOW_COORDINATOR_TEXT` + `BuiltEngine.shutdown` 组合句柄，#365 验收 4 条（TUI subagentManager 装配完整 / spawn_subagent 工作 / registerShutdown TUI 路径接线 / TUI 测试通过）一次性收口。

---

## 1. 上下文与现状

| 现状（master @ 7adef75）                                                                                                                                                                                   | 证据                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/tui/deps.ts` 的 `buildTuiDeps`（deps.ts:80-171）自建 `createDefaultAciRegistry` + `createAciExecutor`，**不经 `buildHarnessEngine`** → subagentManager、IKNOW_COORDINATOR_TEXT、shutdown 句柄全部缺席 | `deps.ts:80-171` 全文未 import `buildHarnessEngine`                                 |
| `src/tui/hub-bridge.ts:106, 126` 已预留 `subagentManager?: SubAgentManager` 字段并透传给 SessionHub，**只是 `buildTuiDeps` 不返回这个字段**，所以是断线                                                    | `hub-bridge.ts:99-127` 字段已就位但上游为空                                         |
| `src/session-api/hub.ts:803` `ensureDeps()` 会懒取 `built.subagentManager` → chat/serve 路径 OK，TUI 不行                                                                                                  | `hub.ts:803` `this.subagentManager = this.subagentManager ?? built.subagentManager` |
| V1.5（#361 / commit 1191138）已让 `build-engine.ts:196-200` 在 `surface !== "ask"` 时自动装配 subagentManager + `BuiltEngine.shutdown` 组合句柄 + `IKNOW_COORDINATOR_TEXT` 注入（build-engine.ts:312）     | git show 1191138 + `build-engine.ts:196-340`                                        |
| `registerShutdown`（`runtime.ts:128-160`）接收 `BuiltEngine` → TUI 入口**从未调**它（`run.tsx:91-105` 装配链无 `registerShutdown` 调用）                                                                   | `run.tsx` 全文 grep 无 `registerShutdown`                                           |

**卡点（唯一）**：`build-engine.ts:225-230` 装配 `createAciExecutor` 时**没传 `hooks`**。TUI 工具摘要行（`#175` T4：`onToolEvent` → tool_use_id 配对 ok/failed 行）靠 `hooks.postToolUse`，**build-engine 当前不暴露这个缝**。

---

## 2. 5-line ACR verdict（cross-check before plan）

> 由会话内调查产生的 self-audit，按 writing-plans ↔ architecture-change-reviewer handoff 契约。Subagent ACR 复审 = 可选 follow-up。

| 轴                           | verdict | 证据（一句话）                                                                                                                                                                                                                                                      |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bounded-context-guardian     | ✅ yes  | 改动只触 `harness/build-engine`（SSOT 装配）+ `tui/{deps,hub-bridge,run}` 三个 TUI 入口文件；不改 ACI tool surface、不引入新 bounded context；`docs/context-map.md` 无需更新                                                                                        |
| defensive-contract-validator | ✅ yes  | 5 类边界（empty/negative/overflow/concurrent/exception）由 T1/T2/T4 各自 acceptance 覆盖；T2 acceptance #2 断言 `spawn_subagent` + `subagent_result` 在场（registry 25 件）；line coverage ≥ 80% 由 `tests/tui/deps-tools.test.ts` 改断言对齐 build-engine 单测覆盖 |
| error-handling-enforcer      | ✅ yes  | T1 沿用 build-engine 既有的 `ValidationError`（build-engine.ts:114）+ `isIknowError` 路由（cli.ts:34）；T2 删自建段后错误路径同源；T4 复用 `registerShutdown` 已有的二次强杀语义（runtime.ts:147-152）                                                              |
| complexity-anti-drift        | ✅ yes  | net diff ≈ -60 行（删 ~90 / 增 ~30）；T1 单函数 +5 行；T2 替换 buildTuiDeps 内部（函数体无新增嵌套）；无新参数 > 4；无嵌套 > 4 层                                                                                                                                   |
| minimal-change-verifier      | ✅ yes  | 1 commit = 1 task；6 个独立 commit（无 expand-contract 需要）；不碰 lockfile（build-engine 不依赖新增 npm 包）；不动 settings.json / .env                                                                                                                           |

**5/5 yes → plan 可执行**。

---

## 3. 依赖图

```
P0（WSL opentui binding 修复） ──────────────────────────────────── 独立前置，平行执行

D1（hooks 透传缝形态） ──► T1（build-engine 加 hooks）──┬──► T2（buildTuiDeps 委托 build-engine + 测试对齐）──┬──► T3（hub-bridge 透传 + 清残留）[∥ T4/T5]
                                                    │                                  │                       │
                                                    │                                  └──► T4（run.tsx 接 registerShutdown）[∥ T3/T5]
                                                    │                                                          │
                                                    │                                                          └──► T5（registerShutdown 测试覆盖 TUI）[∥ T3/T4]
                                                    │
P0 完成后才能在 WSL 跑 TUI 集成测试（单元测试不依赖）
```

---

## 4. Tracer Bullets

### P0. `[task]` WSL @opentui/core-win32-x64 binding 缺失修复 `[parallel with D1/T1/T2/T3/T4/T5]`

- **背景**：#365 验收第 4 条「TUI 测试通过」受 WSL 环境 `@opentui/core-win32-x64` binding 缺失阻塞（git log 7adef75 注释已记录）。该问题与本计划接线无共享状态，但单元测试之外需要 TUI 真跑（T3/T4 的集成验证 + T5 的覆盖）才有 ground truth。
- **Affects**: 仓库根 `package.json`（devDep `optionalDependencies` 或 `@opentui/core` 全平台包）、`scripts/tui-binding-probe.ts`（新探针）、`README.md`（「TUI on WSL」段）
- **Acceptance**:
  1. `npm install --include=optional` 在 WSL Ubuntu 22.04 下不再缺失 `@opentui/core-win32-x64`；`node -e "require('@opentui/core')"` exit 0
  2. `npm run probe:tui-binding`（新探针）输出 `PASS binding loadable` + 6 类（TUI 渲染器构造 / 销毁 / 简单 mount / Ctrl+C 路径 / multi-line 渲染 / 全屏 alt-screen）全绿
  3. `README.md`「TUI on WSL」段加 1 行：本机依赖含 `optionalDependencies`，`npm ci` 自动装；缺失时 fallback 走 Node 子路径
- **执行者**：operator 手做（npm 仓库选型 / WSL 测试），不强制 TDD（探针先行，结论回填）
- **Per-ticket loop**：ops-probe → 实测通过 → 提交

### D1. `[decision]` build-engine hooks 透传缝形态确认（onToolEvent vs 其他）`[blocks: T1]`

- **Question**: 唯一的接缝形态选择——`buildHarnessEngine` 加可选 `hooks?: { postToolUse }` 透传（5 行，TUI 传 `onToolEvent`）；还是其他形态？
- **候选**:
  - **A**（推荐）：`build-engine.ts:225` 在 `createAciExecutor` 调用处加 `...(opts.hooks ? { hooks: opts.hooks } : {})`；BuildEngineOpts 加 `readonly hooks?: PostToolUseHook`。chat/serve 不传 → 字节级零变化。TUI 在 `buildTuiDeps` 内调 build-engine 时传入 `hooks.postToolUse: onToolEvent`。
  - **B**：TUI 拿 `built.deps.executor` 再包一层 `createAciExecutor({ inner: built.deps.executor, ... })` 叠 hooks。需要 build-engine 额外暴露 `baseExecutor` / `catalog` / `policy`，或 TUI 自建 registry——后者退回去自建。
  - **C**：放弃 TUI 工具摘要行观测（UI 功能失效，#175 T4 落地倒退）。
- **裁决（建议）**: **A**。理由：(1) `createAciExecutor` 本身已支持 hooks（`deps.ts:121-146` 已在用），build-engine 漏传 ≠ 不能传；(2) 改 build-engine 5 行，TUI 端零额外包装；(3) 工具摘要观测是 TUI 显性 UI 功能，C 不可接受；(4) B 把 build-engine 当黑盒再开背，违反 SSOT 精神。
- **Affects**: `plans/365-tui-subagent-wiring.md` D1 裁决区（一句话记入）
- **Acceptance**: D1 裁决区填定 `A` 或 operator 指定其他形态，并写一句话理由；T1 按此落
- **执行方式**：deep-dive-protocol 一问（5 分钟内）即可，无需 sub-agent

### T1. `[implementation]` build-engine.ts 加可选 hooks 透传 `[blocks: D1] [parallel with P0]`

- **Affects**: `src/harness/build-engine.ts`（BuildEngineOpts 加 `readonly hooks?: PostToolUseHook`，第 225-230 行 createAciExecutor 调用处加 spread；~5 行）
- **Acceptance**:
  1. `BuildEngineOpts.hooks` 可选；不传 → `npm test` + `npm run typecheck` 全绿，`git diff` 显示 `createAciExecutor` 调用字节级不变（chat/serve 路径零影响）
  2. `PostToolUseHook` 类型 import 自 `src/harness/permission/types.ts`（deps.ts:117-128 已用）
  3. 新增单测 `tests/build-engine-hooks.test.ts`：构造一个 `BuildEngineOpts` 带 hooks；断言 `built.deps.executor` 是 `createAciExecutor` 返回类型；用 stub hook 验证 `postToolUse` 在 executor 层被触发（与 `tests/tui/deps-tools.test.ts` 现有 postToolUse 测试对齐）
  4. `npm test` + `npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` buildTuiDeps 委托 buildHarnessEngine + 测试断言对齐 `[blocks: T1] [parallel with T1]`

- **Affects**: `src/tui/deps.ts`（buildTuiDeps 内部重写：调 `buildHarnessEngine({surface:"tui", askUser, permissionMode, session, hooks, memory:{enabled:true}})`，删自建 registry/executor/system 那 ~90 行；返回多 2 个字段 `subagentManager?` + `shutdown?`）、`src/tui/deps.ts` 头注释更新（去 020 历史注释、加 SSOT 委托说明）、`tests/tui/deps-tools.test.ts`（断言工具面 = 25 件含 `spawn_subagent` / `subagent_result`，加 `onToolEvent` 触发断言）
- **Acceptance**:
  1. `buildTuiDeps` 文件 ≤ 80 行（原 171 行）；仍返回 `LoopEngineDeps`；新增 `subagentManager?: SubAgentManager` + `shutdown?: () => Promise<void>` 两个可选字段
  2. `tests/tui/deps-tools.test.ts` 断言 buildTuiDeps 返回的 registry 工具面 = 25 件 + 含 `spawn_subagent` + 含 `subagent_result`（与 chat 路径 build-engine 同源）
  3. `tests/tui/deps-tools.test.ts` 新增断言：`onToolEvent` 钩子在 executor 层被触发，event 含 `toolName` + `toolUseId` + `kind` + `payload?`（与 deps.ts:127-145 同形态）
  4. `buildTuiDeps` 的 memory 装配显式 `memory:{enabled:true}`；permissionMode / sessionGrants 透传给 build-engine
  5. `npm test` + `npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` hub-bridge 透传 subagentManager + 清 `#361` 残留注释 `[blocks: T2] [parallel with T4/T5]`

- **Affects**: `src/tui/hub-bridge.ts`（`CreateTuiBridgeOptions.deps` 从 `LoopEngineDeps & { subagentManager? }` 改为 `LoopEngineDeps`；新增独立参数 `subagentManager?: SubAgentManager`；第 26-30 / 99-127 行的 `#361` 残留注释清掉，注释简化为「manager 由 buildTuiDeps 经 buildHarnessEngine SSOT 装配」）、`tests/tui/hub-bridge.test.ts`（如存在）增字段断言
- **Acceptance**:
  1. `createTuiBridge({ deps, subagentManager })` 接受独立参数；透传给 `SessionHub`（hub.ts:363 既有 `subagentManager` 字段，无改动）
  2. 文件全文 `grep -nE '#361|29c01fc|9a745ff|a2be099'` 输出 0 命中（残留注释清干净）
  3. `npm test` + `npm run typecheck` 全绿；hub-bridge.test.ts 字段断言覆盖
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` run.tsx 接 registerShutdown + 透传 subagentManager/shutdown `[blocks: T2] [parallel with T3/T5]`

- **Affects**: `src/tui/run.tsx`（`buildTuiDeps` 调用结果 destructure `{ deps, subagentManager, shutdown }`；`createTuiBridge({ ..., subagentManager })`；`registerShutdown({ shutdown: built.shutdown })` 调用挂在 process 退出钩子；~15 行增）；如需上溯 cli.ts（视实现形态决定）
- **Acceptance**:
  1. `runTui` 启动时若 `built.shutdown` 存在 → 调一次 `registerShutdown({ shutdown: built.shutdown })`（runtime.ts:128 API），等价于 a2be099 时代的三入口接线
  2. `hub-bridge` 的 `createTuiBridge({ subagentManager })` 拿到 manager → SessionHub 透传到 `built.subagentManager` 字段（hub.ts:803 ensureDeps 路径继续工作）
  3. Ctrl+C 在 TUI 下退出 → `BuiltEngine.shutdown` 调 `Promise.all([mcp?.shutdown, subagent?.shutdown])` 组合句柄，subagent 子进程被 SIGTERM（与 chat/serve 一致）
  4. `npm test` + `npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` registerShutdown 测试扩展覆盖 surface:"tui" `[blocks: T2] [parallel with T3/T4]`

- **Affects**: `tests/cli/register-shutdown.test.ts`（新增 surface:"tui" case：构造带 shutdown 句柄的 BuiltEngine，调 registerShutdown，断言 process.on('SIGINT') handler 已挂、dispose() 调用 built.shutdown()）
- **Acceptance**:
  1. `register-shutdown.test.ts` 新增 case "surface:tui 触发 shutdown 组合句柄"：mock BuiltEngine.shutdown 计数器，构造 `process.emit('SIGINT')` 后断言计数器 +1
  2. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## 5. 验收汇总（#365 acceptance 映射）

| #365 验收条件                                      | 落点                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| TUI 入口 subagentManager 装配完整                  | T2（build-engine SSOT）+ T3（hub-bridge 透传）                                  |
| TUI 下 spawn_subagent 工具正常工作（与 chat 等价） | T2 acceptance #2（25 件含两件 subagent）+ T4 acceptance #2                      |
| registerShutdown TUI 路径接线恢复                  | T4 acceptance #1 + T5 acceptance #1                                             |
| TUI 测试通过                                       | P0 acceptance #1 + #2（WSL binding 修好）→ T2/T3/T4/T5 的 TUI 测试在 WSL 下真跑 |

---

## 6. 依赖出典

- TUI 装配现状：`src/tui/deps.ts:80-171`、`src/tui/hub-bridge.ts:99-127`
- build-engine SSOT 装配缝：`src/harness/build-engine.ts:106-340`（V1.5 后状态）
- 前景 spawn 契约：ADR-0014 决策 1-3（默认 `wait:true`、drain 异步臂、引导层）
- registerShutdown：`src/cli/runtime.ts:128-160`
- 工具面 SSOT 工厂：`src/harness/aci/tools/registry.ts:createDefaultAciRegistry`
- 跳过 commits 历史：git log 9a745ff / a2be099 / 29c01fc / 4a19b9c / 7adef75

---

## 7. 不在本计划范围

- **SPEC-2 沙箱装配 / SPEC-3 trace**：归 #357 / #358 spec，独立计划
- **coordinator mode（V2 候选）**：归后续地图
- **TUI 渲染层改动**：本计划不改 `tui/{app.tsx,ask-user.tsx,session-state.tsx,...}` 等 React 组件层

---

## 8. 完成定义

- P0 在 WSL 下 binding 探针全绿
- D1 决议写入 plan（一句）
- T1-T5 各 1 commit 共 5 个 commit 在 #365 分支上线性展开（按依赖顺序）
- `npm test` + `npm run typecheck` 全绿
- #365 验收 4 条逐条勾选
- #365 关闭 + 地图 #331 追加 done 记录
