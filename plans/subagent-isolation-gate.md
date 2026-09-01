# Plan: 子代理隔离门禁（subagent isolation gate）

**Goal:** worktree 隔离开关 ON 时，子代理不再能绕过门禁写主仓；且会话改绑前后派出的后台子代理，结果一条都不丢。
**Approach:** 两件事必须一起改、且有严格顺序。先修 hub 的 manager 收口（改绑会产生第二个 manager，而 hub 只认第一个，后台子代理结果落空）；再把 `spawn_subagent` 从「读」改判为按**有效工具面能力**决定拦或放。顺序不能反——判据先落会让所有子代理都挂到新 manager 上，把「漏一部分」变成「全漏」。判据按能力推导而不按角色名，是为了 catalog 扩展与将来的自定义子代理不必回头改这段。
**Spec link:** none — 合同来自操作员对齐（2026-08-31）+ ADR-0037；本轮不补 spec。
**Tracker:** 本计划不创建、不嵌入 GitHub issue 边表（操作员指定 fallback，用本地 markdown）。
**SSOT（2026-09-01）：** 本文不是 worktree 隔离全局权威。合同权威 = ADR-0037 + ADR-0040；计划① `worktree-isolation-model-provision`（`f68580a0`）与计划② `worktree-session-roots`（`da01fde4`）仍是隔离主计划。本文只作本分支子集 tracker，合并后勾选归档，不升格、不丢弃（缺口 A/B 与 T1 顺序约束无 ADR 替代）。
**ACR:** PASS（2026-08-31，verdict block 见下文「ACR」节）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

> 不与 ADR-0037 冲突，而是补它的静默面：ADR-0037 通篇以「会话」为单位，从未定义子代理相对 task worktree 的根归属。T2 负责把这个身份写成 ADR，不在实施里默认。

## 待写入（由 T2 落盘，其余 bullet 提交不刷 CONTEXT/ADR）

- CONTEXT.md 新词「子代理根归属」：子代理继承父会话**生效根**，不是独立隔离单元；manager 层用父 conversationId，worker/LoopEngine 层用自己的 conversationId，这个双重身份此前无词。
- CONTEXT.md 新词「派发门禁判据」：按有效工具面**能力**推导，不按角色名匹配。
- ADR（新编号）：子代理在 worktree 隔离下的身份 = 父会话执行臂，共享父 task worktree。三真（hard to reverse / surprising w/o ctx / real trade-off）。

## 现状与缺口（实施依据）

**缺口 A — 子代理绕过门禁写主仓。**
`classifyCall`（`src/harness/isolation/worktree-gate.ts`）把 `spawn_subagent` 归为 read，不触发建树。`manager.buildWorkerPayload()` 在 `def.sandboxRoot` 缺省时直接继承父 `sandboxRoot`。worker 只装配 `createExecutor` + `createAciExecutor`，**不包 worktree 门禁**。三者叠加：父还在主仓时派出的子代理拿到主仓根且无人拦截 → 违反 ADR-0037 §6「建树/绑定失败后的主仓零写入是验收项」。

**缺口 B — 改绑后 manager split-brain。**
`hub.ts:849 / :2598 / :2776` 均为 `this.subagentManager = this.subagentManager ?? built.subagentManager`，第一个 manager 永久占位；`attachSubagentWake` 首次挂上即 `return`，永不重挂。而派活走的是 registry 内的 per-root manager（`build-engine.ts:564`）。结果：spawn 用新 manager，drain / wake / listSubagents 用旧 manager。`wait:true` 前台不受影响（handler 直接 `await manager.waitFor`）；`wait:false` 后台子代理成为孤儿。

**前提（已核实）：** `engineByRoot` 全文只有 `set` 与读，无 `delete`，仅进程退出时统一 shutdown。故聚合面 v1 永不移除 manager 是安全的。

**已核实的既有保证（判据的地基）：**
`explore` 的 deny 为 `["edit_file","write_file"]` 且 `bashMode: "readonly"`；`bashMode === "readonly"` 在 `bash.ts` 派生 `cwdReadonly: true`，fence 收 `--ro-bind cwd cwd`（validator + 内核双层），前台/后台两条路对齐；worker 的 `createDefaultAciRegistry` 不传 `memoryDir` / `todoDir` / `mcpManager` / `subagentManager` / `backgroundManager`，故只读子代理无旁路写通道。

## 判据（T4 实施的合同）

放行（只读，留在主仓，不建树）当且仅当**两维同时成立**：

1. 有效工具面不含 `write_file`，也不含 `edit_file`；
2. 有效工具面不含 `bash`，**或** 该角色 `bashMode === "readonly"`。

任一不成立 → 判为会写 → 拦截并触发建树。

- `bashMode` 只来自 catalog 角色定义，**不受父代理 `disallowedTools` 影响**：父代理无法把 `any` 说成 `readonly`，只能整个 deny 掉 `bash`。两维必须分开求值，不得合并成「父代理声明只读即只读」。
- 未知角色 → `resolveBashMode` fallback 为 `"any"` → 判为会写 → 拦。功能侧的宽松 fallback 与门禁侧的保守判定方向相反，组合后 fail-closed。
- 判据返回**结论 + 原因**（哪一维不过），供门禁消息与将来的自定义子代理诊断使用。

## 非目标（本计划显式不做）

- 门禁失败文案改造（各 `kind` 补可执行下一步）——另轨。
- `glob` 对 gitignore 的静默过滤——另轨。
- `.worktreeinclude` 等价物（task worktree 缺 `.env`）——另轨。
- 每个子代理一棵独立 worktree。
- 让父代理自由组合 `bashMode`（需给信封加字段）。
- `hub.ts:2602-2604` 的 `autoMemory` / `overlayMemoryPrefetch` 同形 `??`——未查证，不顺手改。
- manager 从聚合面移除的策略（前提是 `engineByRoot` 开始淘汰引擎，今日不成立）。

## ACR

```
bounded-context-guardian: yes — 聚合面与判据都落在 harness/subagent（子代理自己的上下文）；worktree-gate 零改动，隔离模块不获得子代理 catalog 依赖；判据经 build-engine 既有 classify 注入缝组合，跨上下文耦合只发生在装配层；hub 只更换所持对象，不获得子代理生命周期逻辑。
defensive-contract-validator: yes — 五类边界均有归属：空（无 manager / 无 completed → 沿用既有 "" 降级）、负向（未知角色 → 判会写 → 拦）、溢出（多根多 manager 并集，结果与遍历顺序无关）、并发（同 conversation 并发首次派发经门禁既有 pending latch 合流为一次 provision）、异常（单个 manager drain 抛错必须被隔离，其余 manager 结果照常返回，不塌成全空）。
error-handling-enforcer: yes — 聚合面不新增静默 catch；单 manager 失败隔离并上报，EXIT 注明「其余 manager 结果照常返回」；判据对未知角色 fail-closed（拦），不静默放行；提取后的推导函数不改变既有 typed 错误出口（AgentCatalogLookupError 语义不动）。
complexity-anti-drift: yes — 聚合面每个方法单一抽象层级，只做并集 / 路由 / 扇出三类转发，不含业务判断；判据是两维求值的纯函数；worktree-gate 零改动故不增复杂度；T3 为纯提取，不引入新抽象层。
minimal-change-verifier: yes — 拆 T1–T4 各单 commit；T3 纯提取（行为零变化）与 T4 行为变更分离，refactor 不与 feature 混；非目标清单显式圈定边界，无 scope creep。
OVERALL: yes — 全 5 项通过，可进入 T1 实施；各 bullet 仍受 per-ticket loop 约束。
```

## Tasks (ordered by dependency)

1. **manager 聚合面：跨改绑收口子代理结果** — tag: `[implementation]`
   - **Inherits:** ADR-0037 §2「创建 worktree 必须改绑本会话」——改绑是既定行为，本 bullet 不改它，只让改绑不再丢结果。`engineByRoot` 无淘汰（已核实）作为「永不移除 manager」的前提。
   - **Surface:** `harness/subagent`（新增只读扇入面）、`session-api`（hub 接线）、`harness/subagent` 既有 host-drain / host-wake 入参类型放宽。
   - **Acceptance:**
     - 对偶两条同时成立：改绑**之后**派出的 `wait:false` 子代理，结果被 drain 到并唤醒主模型；改绑**之前**派出、彼时仍在运行的子代理，改绑后其结果**仍**被 drain 到。
     - 「把 `this.subagentManager` 改为指向最新 manager」这一实现无法同时通过上述两条（第二条必红）——该反例入测试集。
     - 结构面：聚合面不暴露 `spawn`，也不暴露 `shutdown`（派活归 per-root manager，遣散归各引擎 entry；重复遣散在类型层不可表达）。
     - 登记按对象身份幂等：同一 manager 重复登记不会导致 `drainCompleted` 的破坏性读被执行两次。
     - 单个 manager 抛错时，其余 manager 的结果照常返回。
   - Status: [x] landed — `9087b5b5` + 会话范围补强 `4a1127a0` + CLI closeout `8cd44d93`（`drainPendingSubagentsBeforeShutdown`；`tests/cli/chat-session-rebind.test.ts` 14 passed）。

2. **子代理隔离身份定案** — tag: `[decision]`
   - **Inherits:** none — ADR-0037 未定义子代理根归属，本 bullet 即产出该定义。
   - **Surface:** `docs/adr/`、`docs/CONTEXT.md`。
   - **Acceptance:** 新 ADR 记录「子代理 = 父会话执行臂，共享父 task worktree」，并写明被否掉的两个备选（每子代理独立树 / 隔离 ON 时子代理一律只读）及其否决理由；`docs/CONTEXT.md` 落「子代理根归属」「派发门禁判据」两词条。产出物即本 bullet 的交付。
   - [blocks: T4]
   - Status: [x] landed — `7c20c021` ADR-0040 + CONTEXT「子代理根归属」「派发门禁判据」。

3. **能力推导与 catalog 合并提取为共用（纯提取）** — tag: `[implementation]`
   - **Inherits:** 判据两维定义（见上文「判据」节）；`bashMode` 不受 `disallowedTools` 影响这一既有事实。
   - **Surface:** `harness/subagent`（catalog / worker / spawn 工具三者共用一份推导）。
   - **Acceptance:**
     - `bashMode` 推导与 catalog deny 合并各自成为**单一来源**，被 worker 装配路径与派发路径共同消费；两条路径对同一输入得出相同结果（同源测试覆盖）。
     - **零变化范围（2026-09-01 实测，选 C）**：spawn wire 字节不变；envelope-fed 生产 worker 工具面不变。`createWorkerDeps({ role: "explore" })` 且无 `disallowedTools` 时，worker 会二次应用 catalog deny（`edit_file`/`write_file` 缺席）——相对 `7c20c021` 的 seam **有变**，不得再宣称全面「worker 工具面不变」。合同锁定见 `a2a9d59d` + `tests/subagent/worker-tool-surface.test.ts`「T3 catalog deny contract」。
     - 判据函数返回结论**与**原因（哪一维不通过）。
   - [parallel]（与 T1 无依赖，可并行）
   - Status: [x] landed commit `332d9742`（含 `assessSubagentIsolation`+`reason`）。**二选一已定 C**：全面零变化不成立；保留 seam 新行为，更新合同 + `a2a9d59d` 锁定测试。wire 与 envelope-fed worker 实测 UNCHANGED。

4. **派发门禁：按能力拦或放** — tag: `[implementation]`
   - **Inherits:** T2 定案的身份契约；T3 的共用判据；`worktree-gate` 既有 `classify` 注入缝与「建树成功仍拦本次调用、下一回合重试」机制。
   - **Surface:** `harness`（装配层组合 classifier）。`worktree-gate` 本身不改。
   - **Acceptance:**
     - 隔离 ON 且会话在主仓时：派 `explore` 直接放行，不建树，子代理在主仓只读运行；派默认角色（`general-purpose`）被拦并触发建树，下一回合重派时子代理落在 task worktree。
     - 未知 `subagent_type` 被拦（fail-closed）。
     - 仅 deny `write_file` + `edit_file`、bash 仍为 `any` 的派发**被拦**（第二维生效，堵住假只读）。
     - 隔离 OFF 时派发路径字节不变。
   - [blocks: T2, T3]
   - Status: [x] landed — 门禁 `0517ecb1` + symbol 写工具 `c16ac3a7` + rebound `sandboxRoot` 断言 `af7624e6`（已复跑绿）。`c16ac3a7` 把 `SYMBOL_MUTATE_TOOL_NAMES` 纳入写能力，比本文「两维判据」更严；验收测试覆盖计划四条 + rebound envelope。脏工作树另有 T1/interrupt/TUI，**不进** T4 PR。
