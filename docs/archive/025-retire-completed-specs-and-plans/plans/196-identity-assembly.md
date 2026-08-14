# Plan: #196 iknow 身份认知装配（identity 认知 + soul 人格 + 首启引导 + 用户画像）

> Spec: `specs/196-identity-assembly.md`（ACR 5/5 PASS，2026-08-06，commit `ac1b65c`）
> Origin: issue #196（feiharness 身份认知装配）
> Base branch: `worktree-196-identity-assembly`（commit 落在本分支，一 bullet 一 commit）
> Tracker: local markdown —— 仓库无既有 plan→issue 工作流；gh 可用，如操作员要求 GitHub issue 可后补（见 §Tracker）

---

## Section 1 — Context-Loop Pre-Check

- **docs/CONTEXT.md 已读**：`append-only messages`（内存权威历史，唯一事实来源）、`loop-engine`、`deps.system` 注入缝（#121 T6 引入）、`HarnessStreamEvent`、`turnCount`、`caller_role`（deprecated in wire）、`agent 真值层`。spec Glossary 原样引用，无新术语引入。
- **docs/adr/ 已读**：ADR-0001（9router 栈，不动 env）、ADR-0004（8 工具集，不动拓扑）、ADR-0005（executor stop signal，identity 段不受影响）、ADR-0006（tool output capping，identity 段不进截断路径）、ADR-0008（token accounting，identity 段不计 cost）。
- **无 ADR 矛盾**：spec 明确 identity 段走 `deps.system` 缝、不注册新工具、不计 token —— 与既有 ADR 正交。
- **架构真值**：`src/harness/build-engine.ts` + `loop-engine.ts` + `model-adapter/` 是 Foundation（016/017 冻结）；`deps.system` 缝在 #121 worktree 已有但**未合入 master**（spec A11 确认）。本 plan 的 T1 是把该缝**从 #121 worktree 提升到 master baseline** —— 这是 spec A11 锁定的架构决策，非新决策。
- **#114 Standing preferences 遵守**：不重排既有 7 段装配顺序（user AGENTS → PRIORITY → project AGENTS → EXISTENCE_POINTER → promote）；identity / soul 在 1-2 步前置插入。
- **spec Boundaries Always 明示行**：identity / soul / bootstrap 三个 const string 是 SSOT，装配时只能引用绝不复制；state.json 写 atomic write；`bootstrap_seeded` 状态机仅在 chat / tui 激活（ask / serve 跳过）。

## Section 2 — ACR 5-Verdict Block（引自 spec L494-499）

- bounded-context-guardian: **yes** — `src/harness/identity/` 独立 bounded context；唯一跨 context 边缘是 `deps.system` 缝；Boundaries 明令 identity/soul 不混段。
- defensive-contract-validator: **yes** — 5 边界类（empty/negative/overflow/exception/concurrent）全覆盖；覆盖率 80/70；SC31-33 覆盖三类降级。
- error-handling-enforcer: **yes** — `IknowIdentityError` discriminated union（4 kind）；降级契约表 6 类；写入路径 allowed-throw。
- complexity-anti-drift: **yes** — 阈值钉死（cyclomatic≤10 / nesting≤4 / fn≤40 / file≤500 / params≤4）；`assembleIdentityContext` 走 `IKNOW_ASSEMBLY_ORDER` 表驱动。
- minimal-change-verifier: **yes** — 零新依赖；不碰 frozen contracts（除 T1 是 spec A11 明确锁定的缝提升）；1 commit = 1 logical task。

## Section 3 — Tracer Bullets（依赖序）

编译耦合拆分依据（explorer 实测）：

- `deps.system` 在 master **不存在**（`grep -n "system" src/harness/build-engine.ts / loop-engine.ts / model-adapter/anthropic-adapter.ts` 全空）。T1 必须先把缝从 #121 worktree 提升到 master（adapter types.ts `LoopAdapter` 接口 + loop-engine `raceModel` call site + build-engine 挂 `system` resolver），否则 T4/T5 无处可挂。
- identity const string（identity/soul/bootstrap/user-template）是纯常量文件，无编译依赖，可与 T2（workspace 初始化）并行 —— 但 T3（assembleIdentityContext 装配）同时消费两者，必须等 T1+T2。
- build-engine 接线（T4）依赖 T1（缝）+ T3（装配函数）+ T2（初始化函数）三者的产物。
- 入口触发（T5）依赖 T4（build-engine 已接线）—— 它是在 cli/runtime.ts / session-api/serve.ts / tui/tui.ts 三处加 `initializeIknowWorkspace()` 调用。
- 测试（T6）依赖 T3/T4/T5 的产物；独立测试文件可拆并行。
- smoke + handoff + CHANGELOG（T7）依赖全部实现完成。

### T1. `[decision]` 提升 deps.system 缝：#121 worktree → master baseline

- **Affects**: `src/harness/build-engine.ts` · `src/harness/loop-engine.ts` · `src/harness/model-adapter/types.ts` · `src/harness/model-adapter/anthropic-adapter.ts` · `src/harness/index.ts`（如有需要）
- **Acceptance**:
  - □ master 上 `LoopEngineDeps` 含 `readonly system?: () => Promise<string | undefined>`；loop-engine `raceModel` 每 turn 调 `deps.system?.()`，结果非 undefined 时透传 `adapter.step(..., { system })`
  - □ adapter `LoopAdapter.step` request 含可选 `system?: string`；anthropic-adapter 在 `system` 存在时传给 SDK `messages.create({ system })`，缺省时零变化（byte-identical）
  - □ `build-engine.ts` 在 memory 开启时挂 `system: createSystemResolver({ cwd, userHome, memoryDir })`（从 #121 worktree 提升）；memory 关闭（ask）时不挂（undefined → 行为零变化）
  - □ 回归：#121 既有 7 段装配测试 `tests/harness/memory/assembly.test.ts` 全绿；`npm run typecheck` + `npm test` 全绿
  - □ **说明**：本 bullet 是**从 #121 worktree 已实现的代码提升**，不是新写 —— 实施 agent 应先读 `git show worktree-wayfinder-121-memory-injection:src/harness/{build-engine.ts,loop-engine.ts,model-adapter/*}`，把缝移植到 master，保持行为逐字节一致
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec A11 + #121 T6 实现（读 worktree 代码移植）。不新增 freeze，是已冻结的 #121 缝的 baseline 落地。[blocks: T3, T4]

### T2. `[implementation]` identity 4 const string + user-template（代码区）

- **Affects**: `src/harness/identity/identity.ts` · `src/harness/identity/soul.ts` · `src/harness/identity/bootstrap.ts` · `src/harness/identity/user-template.ts`
- **Acceptance**:
  - □ `identity.ts` 导出 `IKNOW_IDENTITY_DEFAULT: string`，含 `Name: iknow` / `Kind: personal agent` / `Signature`，**不含** core truths / boundaries / vibe / continuity（spec A13 边界：认知层只放本体）
  - □ `soul.ts` 导出 `IKNOW_SOUL_DEFAULT: string`，含 `## Core Truths` / `## Boundaries` / `## Vibe` / `## Continuity` 四段，**不含** Name / Kind / Signature（spec A13 边界：人格层只放行为风格，Vibe 归人格）
  - □ `bootstrap.ts` 导出 `IKNOW_BOOTSTRAP_PROMPT: string`（首启对话脚本，参考 ohmo BOOTSTRAP_TEMPLATE：Goals / Style / When done 三段）
  - □ `user-template.ts` 导出 `USER_TEMPLATE: string`（Profile / Defaults / Ongoing context / Preferences / Notes 五段，参考 ohmo USER_TEMPLATE）
  - □ 认知 vs 人格边界：`grep -c "core truths" identity.ts` = 0；`grep -c "name:" soul.ts` = 0（case-insensitive）；`grep -c "vibe" identity.ts` = 0；`grep -c "signature" soul.ts` = 0（spec SC 11-14）
  - □ 单文件 ≤ 500 行、函数 ≤ 40 行（本 bullet 全 const，天然满足）；`npm run typecheck` 退出 0
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec Code Style（IKNOW_IDENTITY_DEFAULT / IKNOW_SOUL_DEFAULT 片段）+ A13 边界 + SC 1-14。const string 是 SSOT，装配层引用不复制。[parallel with T2b]

### T2b. `[parallel]` [implementation] workspace 初始化 + state.json 状态机

- **Affects**: `src/harness/identity/workspace.ts` · `src/harness/identity/index.ts`（新导出）
- **Acceptance**:
  - □ `workspace.ts` 导出 `iknowWorkspaceRoot()`（`path.join(os.homedir(), ".iknow")`）、`initializeIknowWorkspace(opts?)`、`readIknowState(workspace?)`、`writeIknowState(patch, workspace?)`
  - □ `IknowStateV1 = { schema_version: 1, bootstrap_seeded: boolean, created_at: string, updated_at: string }`
  - □ `initializeIknowWorkspace` eager + idempotent：mkdir -p `~/.iknow/`；user.md 不存在才 seed（`USER_TEMPLATE`）；state.json 不存在才写（`bootstrap_seeded: false`）；**不创建** identity.md / soul.md / bootstrap.md（代码常量，非用户文件）—— spec Code Style 明示
  - □ `writeIknowState` atomic write（temp + rename），PATCH 单字段 + `updated_at` 同步
  - □ 错误降级契约：`readIknowState` JSON 损坏 → skip（log warning）；schema_version 不匹配 → skip（log warning）；`initializeIknowWorkspace` mkdir/writeFile 失败 → allowed-throw typed `IknowIdentityError`（spec 降级契约表）
  - □ `npm run typecheck` + `npx vitest run tests/harness/identity/workspace.test.ts` 全绿（TDD 先行）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec Code Style（workspace.ts 骨架）+ 错误契约表 + SC 9/10/24-27。原子写 = `writeFile(tmp) → rename`，防半写 JSON 损坏。[blocks: T3]

### T3. `[implementation]` assembleIdentityContext 9 段装配 + 入口判定

- **Affects**: `src/harness/identity/index.ts`（`assembleIdentityContext` + `shouldIncludeBootstrap` + `IKNOW_ASSEMBLY_ORDER`）· `src/harness/identity/index.ts`（新导出）· `tests/harness/identity/system-injection.test.ts`
- **Acceptance**:
  - □ `assembleIdentityContext({ cwd, userHome, bootstrapActive })` 返回 9 段拼接字符串或 undefined（memory 关闭时）；段序锁死（spec `IKNOW_ASSEMBLY_ORDER`）：
    1. identity → 2. soul → 3. user_profile → 4. bootstrap（仅当 bootstrapActive 且 state.bootstrap_seeded=false）→ 5. user_agents（#121）→ 6. priority_dec（#121）→ 7. project_agents（#121）→ 8. existence_pointer（#121，memory non-empty）→ 9. promote（#121）
  - □ identity 在 soul 之前（`indexOf("iknow Identity") < indexOf("iknow Soul")`）；user AGENTS 在 PRIORITY 之前（守 #121）
  - □ `shouldIncludeBootstrap(surface)`：chat / tui → true；ask / serve → false（spec 入口覆盖矩阵）
  - □ 错误降级：user.md 缺失 → skip；state.json 缺失 → 视为 bootstrap_seeded=false → bootstrap 注入；读失败 → skip 不抛（spec 降级契约表）
  - □ 装配路径只读（不写盘；除 `writeIknowState({ bootstrap_seeded: true })` 在 bootstrap 完成钩子）
  - □ 9 段顺序测试：`npx vitest run tests/harness/identity/system-injection.test.ts -t "order"` 全绿；`-t "user agents before priority"` 全绿
  - □ `npm run typecheck` + `npx vitest run tests/harness/identity/system-injection.test.ts` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec Code Style（`IKNOW_ASSEMBLY_ORDER` const array + 入口矩阵 + 降级契约）+ SC 23/28-30。建议表驱动 `for (const seg of IKNOW_ASSEMBLY_ORDER) ...`（ACR complexity 建议）。user_profile 段读 `~/.iknow/user.md`，bootstrap 读 state.json。[blocks: T4]

### T4. `[implementation]` build-engine 接线：deps.system 挂 assembleIdentityContext

- **Affects**: `src/harness/build-engine.ts` · `src/cli/runtime.ts`（如有触发）· `tests/harness/identity/system-injection.test.ts`（扩展 4 入口 mock）
- **Acceptance**:
  - □ `buildHarnessEngine` 在 memory 开启时 `system` 调 `assembleIdentityContext({ cwd, userHome, bootstrapActive })`；`bootstrapActive` 由入口 surface 决定（chat/tui → true，ask/serve → false）
  - □ 入口 surface 判定接线：`buildHarnessEngine` 新增 `surface: "chat" | "tui" | "ask" | "serve"` opts 字段（默认 chat？需确认—— spec 说 serve 跳过 bootstrap，chat 激活）
  - □ memory 关闭（ask `{ enabled: false }`）时 `system` 不挂（undefined → 行为零变化，守 #121）
  - □ 4 入口 mock 测试：`tests/harness/identity/system-injection.test.ts` 覆盖 chat/tui/ask/serve 的 `system` 装配结果（mock harness 退化为 stub-model 路径）
  - □ `npm run typecheck` + `npx vitest run tests/harness/identity/system-injection.test.ts` + `tests/harness/memory/assembly.test.ts` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec A11（缝提升）+ A12（入口矩阵）+ SC 15-22。surface 字段是 build-engine 新 opts（不破坏既有调用——可选字段默认值）[blocks: T5]

### T5. `[implementation]` 4 入口触发 initializeIknowWorkspace

- **Affects**: `src/cli/runtime.ts` · `src/session-api/serve.ts` · `src/tui/tui.ts` · `src/cli.ts`（如有）· `src/tui/index.ts`（如有）
- **Acceptance**:
  - □ chat 入口启动时调 `initializeIknowWorkspace()`（`grep -c "initializeIknowWorkspace" src/cli/runtime.ts` ≥ 1）
  - □ serve 入口启动时调 `initializeIknowWorkspace()`（`grep -c "initializeIknowWorkspace" src/session-api/serve.ts` ≥ 1）
  - □ tui 入口启动时调 `initializeIknowWorkspace()`（`grep -c "initializeIknowWorkspace" src/tui/tui.ts` ≥ 1）
  - □ 三处调用都 eager + idempotent（重复调用无副作用，spec A12）
  - □ `npm run typecheck` + `npm test` 全绿（含 TUI / serve 既有测试不回归）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec A12（4 入口）+ SC 17-19。trace 入口（`src/traceserver/`）不调 buildHarnessEngine，不触发（spec A12 排除）。[blocks: T7]

### T6. `[parallel]` [implementation] identity 装配单元测试（4 文件）

- **Affects**: `tests/harness/identity/identity.test.ts` · `tests/harness/identity/bootstrap.test.ts` · `tests/harness/identity/workspace.test.ts` · `tests/harness/identity/system-injection.test.ts`
- **Acceptance**:
  - □ `identity.test.ts`：identity / soul 段拼装 + 认知 vs 人格边界（SC 11-14）+ `-t "identity before soul"`（SC 29）
  - □ `bootstrap.test.ts`：BOOTSTRAP 首启触发 + state.json 写入（SC 24/27）；bootstrap_seeded false→true 唯一迁移路径
  - □ `workspace.test.ts`：`-t "roundtrip"`（state.json 读写，SC 26）+ `-t "JSON corrupt"`（SC 31）+ `-t "schema invalid"`（SC 32）+ `-t "user.md missing"`（SC 33）+ eager/idempotent
  - □ `system-injection.test.ts`：4 入口 mock 覆盖（SC 16）+ `-t "order"`（SC 28）+ `-t "second skip"`（SC 27）+ `-t "user agents before priority"`（SC 30）
  - □ 覆盖率目标：`src/harness/identity/**/*.ts` line ≥ 80%、branch ≥ 70%（vitest --coverage）
  - □ `npx vitest run tests/harness/identity/` 全绿；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec Testing Strategy（5 边界类 + 覆盖率 + SC 16/24-33）。测试用 fixture 控制 cwd/userHome，不污染真实 `~/.iknow/`（spec SC 29 修订说明）。[parallel with T4/T5]

### T7. `[implementation]` smoke + handoff + CHANGELOG

- **Affects**: `scripts/i12-identity-assembly-smoke.ts`（新）· `docs/handoff/<date>-identity-assembly/` · `CHANGELOG.md`
- **Acceptance**:
  - □ `scripts/i12-identity-assembly-smoke.ts` 存在，6 条断言：identity 段注入 / soul 段注入 / user.md 存在性 / BOOTSTRAP 首启触发 / state.json 写入 / 二次启动跳过 BOOTSTRAP（spec Commands + SC 37）
  - □ `npx tsx scripts/i12-identity-assembly-smoke.ts` 退出 0（SC 37）
  - □ `mkdir -p docs/handoff/2026-08-06-identity-assembly && cp /tmp/i12-smoke-output.txt docs/handoff/2026-08-06-identity-assembly/`（SC 38）
  - □ CHANGELOG `0.1.0 (unreleased)` 区新增 Feature 条目（SC 39）
  - □ `npm test` 全绿（CHANGELOG / scripts 不破坏任何测试）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec Commands + SC 37-39。smoke 脚本对齐 i9/i10/i11 命名惯例（`scripts/i<N>-<feature>-smoke.ts`）。

---

## Dependency Graph

```
T1 (deps.system 缝提升：master baseline)
 ├─ T2 (identity 4 const string) ──────────┐
 │                                          ├─ T3 (assembleIdentityContext 9 段)
 └─ T2b (workspace init + state.json) ─────┘   │
                                                ├─ T4 (build-engine 接线 + 入口 surface)
                                                │   └─ T5 (4 入口触发 init)
                                                │       └─ T7 (smoke + handoff + CHANGELOG)
                                                └─ T6 (identity 单元测试 4 文件) ─ [parallel with T4/T5]
```

执行序（串行主线 + 并行对）：T1 → {T2 ∥ T2b} → T3 → T4 → T5 → T7；T6 可与 T4/T5 并行。
并行对 T2/T2b 由两个子代理同时实施（零共享文件：identity.ts 等 4 const vs workspace.ts 独立）。

## 非目标与后继（不在本 plan）

- **#199 flaky test 修复**（`tests/harness/aci/tools/helpers.test.ts:148`）：baseline 既有，另一会话已着手；本 plan 不触碰 helpers.*。
- **identity 内容设计深化**（core truths 具体文案、signature 字面值）：留给 T2 实施时按 spec Code Style 片段填充，本 plan 不展开。
- **web 前端展示 identity**（如侧栏显示 "iknow" 头像）：spec 未要求，不扩 diff。
- **`deps.system` 缝的性能缓存**（identity 字符串 per-turn 重读）：spec 明确每 turn 解析（用户可改 user.md turn 级生效），不做 TTL 缓存。

## Verification Checklist（writing-plans 自检）

- [x] 7 个 tracer bullets（T1-T7），均编号，1 bullet = 1 commit
- [x] 每 bullet 1 组二进制验收标准（退出码 / 测试全绿 / grep 断言）
- [x] 依赖序排列 + `[parallel]` / `[blocks]` 标注
- [x] 每 bullet 带 `[decision]` 或 `[implementation]` 标签（T1 = decision 缝提升；T2-T7 = implementation）
- [x] 每 `[implementation]` bullet 嵌入 Per-ticket loop 行（ADR-0012）
- [x] Section 2 ACR 5-verdict（5/5 yes，OVERALL PASS）
- [x] Section 1 context-loop 预检（CONTEXT.md + docs/adr/ 已读，无矛盾静默覆盖）
- [x] 实施要点只写约束来源，不写代码片段
