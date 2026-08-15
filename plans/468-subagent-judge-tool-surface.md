# Plan: 468 — Sub-agent worker tool surface = declared deny-list（判官只读契约的前置 bug fix）

**Goal:** 让 `SubAgentDefinition.disallowedTools`（写到 `WorkerEnvelope.disallowedTools`）实际生效——裁掉 worker 进程的可见工具面与执行工具面，判官（及任何声明 deny-list 的子代理）拿不到 `bash / edit_file / write_file / web_fetch / web_search`，声明面 = 实际面。

**Architecture:** def-list 期过滤（`createAciRegistry(tools)` 之前），在 `createDefaultAciRegistry` 工厂内仿 memoryDir 条件化机制做 deny 镜像过滤 + Gate 3 镜像对照；worker 通过 `CreateWorkerDepsOptions` 新可选入参透传 envelope 上的 deny-list；裁剪工具复用既有宽容模式 helper `buildWorkerToolSurface`（不做 fail-fast，与 #468 A2 对齐）。`inner`（executor 实际可执行面）与 `visibleSchemas`（模型 promptTools 可见面）由构造期快照天然同步——构造期保证，不事后修补。

**Tech Stack:** TypeScript + Node（ESM，tsc strict）。无新依赖。复用既有 `src/harness/subagent/role.ts:buildWorkerToolSurface`。

**Spec link:** `specs/468-subagent-judge-tool-surface.md`

**前置依赖**: 无（可先行）。下游：`plans/449-verify-evidence-first-loop.md` 的判官只读前提。

**Tracker:** GitHub（label `ready-for-agent`，native blocking via addBlockedBy；票创建留待 operator 放行）。

---

## Architecture Change Reviewer verdict

引自 spec（Round 2 复审 PASS，2026-08-16）：

```
bounded-context-guardian: yes — 新边 registry.ts → subagent/role.js 无环（role.ts 只 import ../errors.js），
  且镜像 registry→subagent 既有边（registry.ts:38-40 已 import spawn-subagent-tool/subagent-result-tool/SubAgentManager）；
  无反向依赖、不碰 wire schema。
defensive-contract-validator: yes — 测试表覆盖六类：正常 / 未知名宽容 / 空/undefined/deny-all 边界 /
  权限（inner+visibleSchemas 双面断言 5 禁项）/ 旧 wire 向后兼容 / 并发 N/A 有据（进程启动期一次性同步装配）。
error-handling-enforcer: yes — 宽容忽略有文档不抛；唯一新 throw = typed EXIT-documented RegistryConstructionError
  （Gate 3 分歧，registry.ts:260-267）；buildWorkerToolSurface 的 {name} 约束由 AciToolDef 经 ToolDef.name 满足；
  无新非类型化失败路径。
complexity-anti-drift: yes — Round 1 幻影 reg.tools 已除；spec 以 aci-registry.ts:18-35 仅暴露 inner/catalog/
  visibleSchemas 为据，明令 createAciRegistry(tools) 前裁剪（registry.ts:270）；Gate 3 镜像过滤具名
  （toolsetNames deny 过滤 + memoryDir excluded 数组机制 registry.ts:252-259）；无 executor 重建 god-function。
  残余注记：factories 键排除、excluded 数组、tools map 三方需协调（双机制幂等），Gate 3 fail-fast + SC5 兜底
  ——guarded drift 非静默。
minimal-change-verifier: yes — 单一逻辑任务（worker 消费 disallowedTools → def-list 裁剪）、1 logical commit；
  envelope/manager/buildWorkerPayload/JUDGE_ROLE 显式不动（spec:52）；worker 缝 grounded
  （CreateWorkerDepsOptions 现无 disallowedTools worker.ts:68-87、runSubagentWorker 只传 env+sandboxRoot
  worker.ts:316-319，透传是真缺口）。
```

---

## Tracer bullets

> Per-ticket loop（ADR-0012）强制：每个 `[implementation]` bullet 的 `Per-ticket loop` 行不可省略。

### T1. `[implementation]` `createDefaultAciRegistry` 增 `disallowedTools?` 入参 + def-list 期裁剪 + Gate 3 镜像过滤

- **Affects**: `src/harness/aci/tools/registry.ts`（`CreateDefaultAciRegistryOptions` 增 `readonly disallowedTools?: ReadonlyArray<string>`；工厂内复用 `buildWorkerToolSurface` 做 def-list 过滤；Gate 3 镜像过滤把 deny 名并入 `excluded` 数组）；`tests/harness/aci/tools/registry.test.ts`（Gate 3 在 deny 过滤下不退化）。
- **Affects (new edge)**: `src/harness/aci/tools/registry.ts` 新 import `import { buildWorkerToolSurface } from "../subagent/role.js"`（依 ACR bounded-context-guardian verdict 验证无环：role.ts 仅 import `../errors.js`，无反向边）。
- **Acceptance**:
  1. `grep -n "disallowedTools" src/harness/aci/tools/registry.ts` → 命中 `CreateDefaultAciRegistryOptions` 字段声明与工厂内 `denySet`/`excluded`/`buildWorkerToolSurface` 至少 3 处。
  2. `grep -rn "buildWorkerToolSurface" src/harness/aci/tools/registry.ts` → 至少 1 处生产调用（SC2）。
  3. `npx vitest run tests/harness/aci` → exit 0（SC5 Gate 3 + 全量 aci 测试不退化）。
  4. `npx vitest run tests/subagent/role.test.ts` → exit 0（既有用例不退化）。
  5. `npm run typecheck` → exit 0。
- **Implementation notes**（非验收命令）:
  - 在 `CreateDefaultAciRegistryOptions`（当前 registry.ts:110-127）追加 `readonly disallowedTools?: ReadonlyArray<string>`。
  - 工厂内（registry.ts:170-273）解构 `opts.disallowedTools`；构造 `denySet = new Set(opts.disallowedTools ?? [])`；把 deny 名并入既有 `excluded` 数组（registry.ts:252-256 形态），使 `toolsetNames`（registry.ts:257-259）同步剔除禁项；同时 `factoryNames = Object.keys(factories).filter(n => !denySet.has(n))`，保持 Gate 3（registry.ts:260-267）对照成立。
  - `const allTools = toolsetNames.map((n) => factories[n]!())`（registry.ts:269-270 当前形态）；再 `const tools = buildWorkerToolSurface(allTools, opts.disallowedTools)`（role.ts:86-108 宽容模式 helper，merge 默认 deny `[spawn_subagent]` + 用户 deny，available 不含的项静默跳过——worker 装配期 spawn_subagent 本就缺席，属合法冗余）；最终 `createAciRegistry(tools)`。双机制幂等（ACR complexity-anti-drift verdict）。
  - `build-engine.ts:294` 等既有调用不传 `disallowedTools` → 行为 byte-identical（默认 undefine，`denySet` 为空，`excluded` 与既有条件键记忆一致，Gate 3 与 buildWorkerToolSurface 都走空路径）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` worker 透传 `workerEnvelope.disallowedTools`（wire 不动）

- **Affects**: `src/harness/subagent/worker.ts`（`CreateWorkerDepsOptions` 增 `readonly disallowedTools?: ReadonlyArray<string>`；`runSubagentWorker` 从 `workerEnvelope.disallowedTools` 取出传入 `createWorkerDeps`；`createWorkerDeps` 内 `createDefaultAciRegistry({...})` 透传新字段）。
- **Acceptance**:
  1. `grep -n "disallowedTools" src/harness/subagent/worker.ts` → 命中至少 3 处：入参字段声明、`runSubagentWorker` 读取、`createWorkerDeps` 透传给 `createDefaultAciRegistry`（SC1 worker 消费 deny-list）。
  2. `git diff -- src/harness/subagent/envelope.ts` → 空（SC7 wire 不变；`WorkerEnvelope.disallowedTools` 字段已经在 envelope.ts:31 已存在，本 bullet 仅消费不修改）。
  3. `git diff -- src/harness/subagent/manager.ts` → 空（spec:52 不动 `buildWorkerPayload`；manager.ts:345-347 已正确序列化 deny-list）。
  4. `git diff -- src/harness/verify/run-classifier-adapter.ts` → 空（spec:52 不动 `JUDGE_ROLE` 声明）。
  5. `npx vitest run tests/subagent` → exit 0（SC6 既有 subagent 测试不退化，向后兼容隐含：WorkerEnvelope 无 `disallowedTools` → `opts.disallowedTools` 为 undefined → 工厂不裁剪）。
  6. `npm run typecheck` → exit 0。
- **Implementation notes**:
  - `CreateWorkerDepsOptions`（当前 worker.ts:68-87）新增字段；按既有可选缝（`model?` / `skillCatalog?` / `trace?` / `userHome?` / `cwd?` / `system?` / `maxTurns?`）风格排列。
  - `createWorkerDeps` 内 `createDefaultAciRegistry({...})`（当前 worker.ts:137-141）按 spec Code Style 形态：`...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {})`——避免 type `{ disallowedTools: undefined }` 直通（既有相同形态证例 `...(opts.memoryDir ? { memoryDir: opts.memoryDir } : {})` 等条件 spread）。
  - `runSubagentWorker`（当前 worker.ts:316-319）从 `workerEnvelope.disallowedTools` 读取后置入 `createWorkerDeps` 入参；`workerEnvelope.disallowedTools` 字段类型已是 `readonly string[] | undefined`（envelope.ts:31），直接透传安全。
  - 不触 `manager.ts` / `run-classifier-adapter.ts` / `envelope.ts` / `role.ts` / `aci-registry.ts`。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` `tests/subagent/worker-tool-surface.test.ts` 端到端断言（声明 = 实际 / 判官只读 / 兼容）

- **Affects**: `tests/subagent/worker-tool-surface.test.ts`（新文件）。仅新增测试，不动既有 `tests/subagent/*.test.ts`。
- **Acceptance**:
  1. `npx vitest run tests/subagent/worker-tool-surface.test.ts` → exit 0。
  2. 文件内至少覆盖六类（SC3 + SC4 + SC6）：
     - **正常 / happy path**：`disallowedTools: ["bash","edit_file","write_file","web_fetch","web_search"]` → 装配后 `AciRegistry.inner` 与 `AciRegistry.visibleSchemas()` 双面均不含上述 5 名；其余工具（含 `read_file` / `grep` / `glob` / `lsp_*` / `tool_search` 等）仍在。
     - **失败路径**：deny-list 含未知名 `["bash","foo_tool_does_not_exist"]` → `buildWorkerToolSurface` 宽容忽略，`inner`/`visibleSchemas` 仍只少 `bash`，不抛、不误裁（spec SC4 失败行）。
     - **边界**：deny-list 空数组 / `undefined` → 工具面 = 全量（除 factory 条件化剔除）；`deny` 掉全部实际工具 → `inner`/`visibleSchemas` 为空集、worker 仍可装配（`createWorkerDeps` 不 crash），后续可由 `runWorkerOnce` 走纯文本路径。
     - **权限 / 判官只读**：用 `JUDGE_ROLE.disallowedTools`（run-classifier-adapter.ts:35-41 完整 5 项）调用 `createWorkerDeps`，断言 `inner`/`visibleSchemas` 双面均无 `bash/edit_file/write_file/web_fetch/web_search` 5 名（SC3 + SC4 权限行）。
     - **空 / 非法 / 旧 wire**：`WorkerEnvelope` 缺 `disallowedTools` 字段（手构 `{ task, sandboxRoot }`）→ 透传 undefined → 工具面 = 全量（向后兼容 SC6）。
     - **并发**：N/A（worker 装配是进程启动期一次性同步裁剪，无并发窗口；用例层附一行注释引用 spec Testing Strategy "并发 N/A"）。
  3. 参数化断言：写一个 helper `assertSurface(reg, denied, kept)`，对正常 / 失败 / 边界三类 reuse，断言形状 = `断言 visibleSchemas 双面 + 断言 inner 协议 registry 键集双面`（依 spec Boundaries Always do）。
  4. 测试用例构造：使用 `tests/subagent/role.test.ts` 既有的 `WORKER_TOOLSET` 形态或直接构造 `{ name, ... }` 对象；stub-model 用既有 `createStubModel`（tests/subagent/worker.test.ts 已用），不依赖真 LLM key。
  5. `npx vitest run tests/subagent` → exit 0（既有用例 + 新用例全绿）。
- **Implementation notes**:
  - 走真实 `createDefaultAciRegistry` 路径（非 stub 替身），保证 Gate 3 在 deny 过滤下不退化是 T1 兜底、此测试是 assert 端。
  - `AciRegistry.inner`（`RegistryImpl`）与 `AciRegistry.visibleSchemas()`（`ReadonlyArray<ToolDef>`）双面断言按 spec Code Style 既定；可用 `visibleSchemas().map(s => s.name)` 收集名集合与 `Object.keys(inner)` / `inner.allNames()` 对照（依 `tests/harness/aci/tools/registry.test.ts` 既有 `list()` 形态）。
  - 不写新 mock；既有用 `tests/subagent/worker.test.ts` 与 `tests/harness/aci/tools/registry.test.ts` 的 stub 与 helper 能直接复用或扩展；不行就小段本地 helper。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Cross-references

### SC ↔ T 覆盖矩阵

| SC  | 验收句（摘要）                                                                          | 主覆盖                                                 | 覆盖 |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---- |
| SC1 | worker 消费 deny-list（`grep -n "disallowedTools" worker.ts`）                          | T2 acceptance 1                                        | —    |
| SC2 | def-list 期裁剪进生产（registry.ts 含 `buildWorkerToolSurface`）                        | T1 acceptance 2                                        | —    |
| SC3 | 判官只读成立（inner+visibleSchemas 双面无 5 禁项）                                      | T3 acceptance 2 权限行                                 | —    |
| SC4 | 声明=实际（参数化宽容忽略未知名）                                                       | T3 acceptance 2 正常 + 失败 + 边界 + 权限              | —    |
| SC5 | Gate 3 不破（deny 过滤后 toolsetNames 与 factories 键集一致；memoryDir 条件化行为不变） | T1 acceptance 3（vitest run tests/harness/aci exit 0） | —    |
| SC6 | 向后兼容（旧 wire → 全量面不裁剪）                                                      | T3 acceptance 2 空/非法行 + T2 acceptance 5            | —    |
| SC7 | wire 不变（envelope/manager schema 无 diff）                                            | T2 acceptance 2 + acceptance 3 + acceptance 4          | —    |

### 并行面

- T1 与 T2 不并行：T2 消费 T1 的工厂能力（`CreateDefaultAciRegistryOptions.disallowedTools` 字段必须先存在，T2 才能透传；否则 ts(2345)）。
- T3 不并行于 T1+T2：装配 + 透传双路径必须都到位，T3 才能端到端断言（不能让 T3 卡 fake）。
- 总结：串行 `T1 → T2 → T3`，没有任何 `[parallel]` 面。

### 实证修正过的 file:line 漂移

| spec 引用                                                                                                                                                                                                                       | 实际位置                                                                                                                                                       | 修正                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `aci-registry.ts:20-26`（Code Style）                                                                                                                                                                                           | `aci-registry.ts:18-35`（AciRegistry interface 主体；含 inner(19-20)/catalog(21)/registerExternal(23)/unregisterExternal(30)/visibleSchemas(32)/discover(34)） | plan T1 notes 改用 `18-35`；ACR verdict 已是 `18-35` |
| `manager.ts:346-348`（manager 序列化 deny-list）                                                                                                                                                                                | `manager.ts:345-347`（`...(def.disallowedTools !== undefined && {` ~`346`、`disallowedTools: [...def.disallowedTools],` ~`347`、`)`,` ~`348`）                 | plan T2 acceptance 3 描述按 345-347；语义无差        |
| 其余 spec 引用 (`worker.ts:68-87` / `worker.ts:137-141` / `worker.ts:316-319` / `registry.ts:38-40` / `registry.ts:252-259` / `registry.ts:260-267` / `registry.ts:270` / `run-classifier-adapter.ts:35-41` / `envelope.ts:31`) | 经 grep 实测全部命中                                                                                                                                           | 无需修正                                             |
| `buildWorkerToolSurface` / `applyRoleDenyList` 生产调用方                                                                                                                                                                       | grep 全仓 0 命中（仅 `src/harness/subagent/role.ts` 定义与 `tests/subagent/role.test.ts` 引用）                                                                | 确认 SC2 验收可验，role.ts 既有 helper 已就位        |

### 路径速查

- spec: `specs/468-subagent-judge-tool-surface.md`
- 工厂入口: `src/harness/aci/tools/registry.ts`（line 170 `createDefaultAciRegistry`）
- worker seam: `src/harness/subagent/worker.ts`（lines 101-200 `createWorkerDeps` / lines 313-323 `runSubagentWorker`）
- deny helper: `src/harness/subagent/role.ts`（lines 86-108 `buildWorkerToolSurface`）
- wire schema: `src/harness/subagent/envelope.ts`（line 31 `disallowedTools?: readonly string[]`，本 bullet 不改）
- 串行封口: `src/harness/subagent/manager.ts`（lines 345-347 `buildWorkerPayload` 已正确序列化，本 bullet 不改）
- 判官声明源: `src/harness/verify/run-classifier-adapter.ts`（lines 35-41 `JUDGE_ROLE.disallowedTools`，本 bullet 不改）
- 测试: `tests/harness/aci/tools/registry.test.ts`（T1 跑以验 Gate 3 不退）；`tests/subagent/worker-tool-surface.test.ts`（T3 新增）；`tests/subagent/role.test.ts`（既有 buildWorkerToolSurface 用例，回归不破）

### 验证（plan done 三项）

1. `cat plans/468-subagent-judge-tool-surface.md | grep -E "^### T[0-9]+\."` → 3 条 tracer bullet 编号齐全
2. 实施后 `git log --oneline` → 3 commits（每个 T 对应一次 commit，1 commit = 1 logical task）
3. `git diff --stat HEAD~3..HEAD` → 每 commit 改动 scope 与 bullet 的 Affects 行匹配（envelope.ts / manager.ts / run-classifier-adapter.ts diff 均为空）
