# Spec: 468 — Sub-agent worker tool surface = declared deny-list（判官只读契约的前置 bug fix）

> 来源：#468 待办 2（disallowedTools 未在 worker 消费）+ #450 G1 Resolution（"判官能力 = 只读；工具面裁剪由 #468 待办 2 承担，G1 以此为事实基线"）。
> 上游 map：#449（verify 证据优先）/ #458（goal 生命周期）。编排与判官门禁见 `verify-goal-gate.md`。本 spec 只保证判官 worker 声明工具面=实际工具面。
> 假设闸门：operator 已授权"自己决策、自己审完写好"（delegated assumption confirmation，沿 `specs/408-session-goal.md` 先例）。

## Glossary（exact copy from docs/CONTEXT.md + 本 spec 新术语）

- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；当前 8 件：`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移（#141 / #191 / a277f68）。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。
  _Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组。
- **前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`，显式选项）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程，与前景/后景正交。
- **判官（judge）【承接 128-verify-classifier 术语】**：command 缺失时接管"任务完成了吗"的子代理 LLM 分类器。本 spec 不改其输入/输出语义，只把其**声明的工具面变成实际工具面**。
- **声明工具面 vs 实际工具面【本 spec 新术语】**：`SubAgentDefinition.disallowedTools` 写进 `WorkerEnvelope` 的是声明面；worker 进程装配后真正可被模型调用的工具集是实际面。当前二者**不相等**（声明面裁了 bash/edit_file/write_file/web_fetch/web_search，实际面没裁）——本 spec 的修复对象。

## Architectural Constraints（ADR 引用）

- **ADR-0004**（tool layer / executor hardening）：工具面由 SSOT 工厂 `createDefaultAciRegistry` 产出，permission middleware 装饰。本 spec 在 registry 产出**之后**按 deny-list 裁剪，不在 entry point 手写工具数组、不另起注册表（守 ACI tool set 的 _Avoid_）。
- **ADR-0014**（subagent-foreground-spawn-default）：worker 恒为独立进程，经 stdin `WorkerEnvelope` 收声明。裁剪发生在 worker 进程内装配期（消费 `workerEnvelope.disallowedTools`），不改父→子 wire 形态（`buildWorkerPayload` 已正确序列化 deny-list，explorer 实证 `manager.ts:346-348`）。
- **冻结契约**：`WorkerEnvelope` / `SubAgentEnvelope` schema 不动；`spawn_subagent` 已因 worker 无 `subagentManager` 而天然缺席（`worker.ts:137-141`），本 spec 不重复表达该排除。

## Objective

修复"判官实际工具面 > 声明工具面"的安全缺陷：`JUDGE_ROLE.disallowedTools`（`run-classifier-adapter.ts:35-41`）声明禁 `bash / edit_file / write_file / web_fetch / web_search`，`buildWorkerPayload` 也把它写进了 `WorkerEnvelope`，但 `runSubagentWorker → createWorkerDeps` 只取 `env + sandboxRoot`，**从不读 `workerEnvelope.disallowedTools`**，也不裁剪 `createDefaultAciRegistry` 的产物（explorer 实证：`CreateWorkerDepsOptions` 无 deny 字段，`role.ts` 的 `applyRoleDenyList`/`buildWorkerToolSurface` 全仓库无生产调用方，仅测试引用）。后果：判官（及任何声明 deny-list 的子代理）实际拿到含 bash/写文件/网络的全量工具集，而 worker 的 `askUser = createNoAskUser()` fail-closed 只拦"需询问"项，写/执行工具不经 ask，只剩 dangerous-command 硬墙。

用户：verify 闭环的消费者（判官必须只读才能成为可信的独立判定者，G1 立场）。成功 = 声明工具面与实际工具面相等，判官拿不到 bash/edit_file/write_file/web_fetch/web_search。

## Tech Stack

不变：TypeScript + Node（ESM，tsc strict）。无新依赖。复用既有 `role.ts` 的 `buildWorkerToolSurface`（宽容模式裁剪 helper，已存在但无生产调用方）。

## Commands

```bash
npm run typecheck                 # tsc -p tsconfig.json --noEmit
npm test                          # vitest：unit + harness + integration
npx vitest run tests/subagent     # 本模块定向
npm run lint
```

## Project Structure

```
src/harness/subagent/worker.ts     # runSubagentWorker 把 workerEnvelope.disallowedTools 透传给 createWorkerDeps；
                                   # createWorkerDeps 把它作为新可选入参传进 createDefaultAciRegistry
src/harness/aci/tools/registry.ts  # CreateDefaultAciRegistryOptions + disallowedTools?: ReadonlyArray<string>；
                                   # 工厂内 def-list 期按 deny-list 过滤（仿 memoryDir 条件化装配先例）；
                                   # Gate 3 镜像过滤（toolsetNames 同步剔除禁项再做对照）
src/harness/subagent/role.ts       # buildWorkerToolSurface 既有 helper 接入生产（宽容模式，def-list 过滤用）
tests/subagent/                    # + worker 工具面裁剪用例（声明 vs 实际相等）
```

不改：`envelope.ts`（wire schema）、`manager.ts`（`buildWorkerPayload` 已正确写 deny-list）、`run-classifier-adapter.ts`（JUDGE_ROLE 声明不变）。

## Code Style

沿用既有风格（显式类型、纯函数优先、注释只解释 why）。核心接缝示意：

```ts
// worker.ts — createWorkerDeps 增加 disallowedTools 入参并透传
export interface CreateWorkerDepsOptions {
  readonly env: IknowEnv;
  readonly sandboxRoot: string;
  readonly disallowedTools?: ReadonlyArray<string>; // ← 新增
  // ...既有可选缝（model/skillCatalog/trace/userHome/cwd/system/maxTurns）
}
const reg = createDefaultAciRegistry({
  env,
  sandboxRoot,
  skillCatalog,
  ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
});

// registry.ts — 在 createAciRegistry(tools) 之前、def-list 期过滤（宽容模式）
// tools = buildWorkerToolSurface(allToolDefs, opts.disallowedTools)
//         |> createDefaultAciRegistry  → inner/catalog/visibleSchemas 全部只含保留项
// Gate 3 镜像：toolsetNames = ACI_TOOLSET_NAMES.filter(n => !deny.includes(n))
//             再做与 factories 键集的对照（既有 memoryDir 条件化同款机制）
```

**为什么在 def-list 期过滤而不是 registry 产出后**：`AciRegistry` 只暴露 `inner`（冻结协议 registry，交给 `createExecutor`）/ `catalog` / `visibleSchemas`，**没有 `tools` 属性**；`inner` 是构造期快照，事后裁剪不可行（ACR review 实证 `aci-registry.ts:20-26`）。裁剪必须发生在 `createAciRegistry(tools)` **之前**——这样 `inner`（executor 实际可执行面）与 `visibleSchemas`（模型 promptTools 可见面）天然同步只剩保留项，声明面 = 实际面由构造保证而非事后修补。

**Gate 3 纪律**：registry 工厂的 `ACI_TOOLSET_NAMES` 与 factories 键集必须一致（SSOT append-only 纪律，miss 即装配期抛 `RegistryConstructionError`）。加入 deny 过滤后，`toolsetNames` 先剔除禁项再做对照，与既有 memoryDir 条件化（memory 缺席时先剔除 memory_recall/memory_save）同款机制，不破 Gate 3。

## Testing Strategy

vitest，落 `tests/subagent/`。覆盖测试规范六类：

| 层          | 内容                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 正常        | 声明 `disallowedTools: ["bash",...]` → worker 工具面不含这些；不声明 → 全量面（除 spawn_subagent）。                                     |
| 失败        | deny-list 含未知工具名 → 宽容忽略（buildWorkerToolSurface 语义），不抛、不误裁。                                                         |
| 边界        | deny-list 空数组 / undefined → 行为等价不裁剪；deny 掉全部工具 → 工具面为空，worker 仍可跑（纯文本回答），不 crash。                     |
| 权限        | 判官 JUDGE_ROLE 声明的 5 个禁项在 worker 装配后**均不可调用**（断言 executor 可见面无 bash/edit_file/write_file/web_fetch/web_search）。 |
| 空/非法输入 | `WorkerEnvelope` 无 `disallowedTools` 字段（旧 wire）→ 等价不裁剪，向后兼容。                                                            |
| 并发        | N/A（worker 装配是进程启动期一次性同步裁剪，无并发窗口）。                                                                               |

## Boundaries

- **Always do**：声明面与实际面相等作为不变量写进测试（断言 `inner` + `visibleSchemas` 双面都无禁项）；裁剪用既有 `buildWorkerToolSurface`（不新造裁剪逻辑）；裁剪在 def-list 期（`createAciRegistry` 调用前），保持 Gate 3 镜像过滤纪律。
- **Ask first**：若需把 `applyRoleDenyList`（严格 fail-fast 模式）而非宽容模式作为默认——#468 给了两个方向，默认按宽容（`buildWorkerToolSurface`），改严格需确认。
- **Never do**：改 `WorkerEnvelope` wire schema；改 JUDGE_ROLE 声明内容；在 registry 产出后试图裁剪 `inner`（冻结快照不可行）；为裁剪另起 tool 注册表或在 entry point 手写工具数组（破 ACI SSOT）；删改既有 subagent 测试。

## Success Criteria（binary，每条映射可执行检查）

1. **worker 消费 deny-list**：`createWorkerDeps` 读取并应用 `workerEnvelope.disallowedTools`。**Check**: `grep -n "disallowedTools" src/harness/subagent/worker.ts`（装配路径有引用）。✅/❌
2. **def-list 期裁剪进生产**：`buildWorkerToolSurface` 在 `createDefaultAciRegistry` 内部有生产调用方（`src/harness/aci/tools/registry.ts`）。**Check**: `grep -rn "buildWorkerToolSurface" src/harness/aci/tools/registry.ts`。✅/❌
3. **判官只读成立**：装配后工具面不含 bash/edit_file/write_file/web_fetch/web_search（`inner` 与 `visibleSchemas` 双面）。**Check**: `tests/subagent/worker-tool-surface.test.ts` 断言 5 项双面缺席。✅/❌
4. **声明=实际**：对任意 deny-list，实际面 = 全量面 − deny-list（宽容忽略未知名）。**Check**: 同上测试的参数化断言。✅/❌
5. **Gate 3 不被破**：deny 过滤后 `toolsetNames` 与 factories 键集仍一致；memoryDir 条件化行为不变。**Check**: `npx vitest run tests/harness/aci`（registry 装配测试含 Gate 3）exit 0。✅/❌
6. **向后兼容**：wire 上无 `disallowedTools` 的旧 envelope → 全量面不裁剪，既有 subagent 测试全绿。**Check**: `npx vitest run tests/subagent` exit 0。✅/❌
7. **wire 不变**：`WorkerEnvelope`/`SubAgentEnvelope` schema 无 diff。**Check**: `git diff -- src/harness/subagent/envelope.ts` 为空。✅/❌

## Open Questions

无阻塞项。宽容 vs 严格裁剪模式默认取宽容（`buildWorkerToolSurface`，#468 明示方向），若 review 要求 fail-fast 再升级，不阻塞 spec。

## Assumptions（operator delegated，逐条挂外部真值）

1. **A1 修复方向 = createWorkerDeps 消费 disallowedTools + def-list 期过滤**（来源：#468 待办 2"createWorkerDeps 接收 workerEnvelope.disallowedTools，在 createDefaultAciRegistry 之后用 buildWorkerToolSurface 裁剪工具面"；ACR review 实证"之后"不可行（`inner` 冻结），修正为"之内/之前"——同一声明的机制修正，不改变语义）。CONFIRMED by #468 + ACR ground truth。
2. **A2 宽容模式为默认**（buildWorkerToolSurface，未知名忽略；applyRoleDenyList 保留给需 fail-fast 的调用方）（来源：#468 待办 2"用 buildWorkerToolSurface（宽容模式）裁剪工具面"）。CONFIRMED by #468。
3. **A3 判官只读是 G1 前置、不随 G1 A/B/C 摇摆**（来源：#468 Step 0 决策确认 + #450 Resolution"工具面裁剪由 #468 待办 2 承担"）。CONFIRMED by #468 Step 0。
4. **A4 同时裁剪执行面与可见面**（inner + visibleSchemas 双面）——推导自 ACI permission middleware 语义 + def-list 期过滤的自然结果，#468 未逐字写但为修复完整性必需。CONFIRMED by 推导（标注为 spec 自述，非 #468 原文）。
5. **A5 不动 wire schema**（buildWorkerPayload 已正确序列化，explorer 实证）——只补 worker 侧消费。CONFIRMED by explorer ground truth。
6. **A6 Gate 3 镜像过滤纪律**（toolsetNames 剔除禁项后再对照 factories 键集，仿 memoryDir 条件化）——推导自 registry 工厂既有机制，spec 自述。CONFIRMED by 推导（registry.ts 实证 memoryDir 同款）。

→ 全部挂 #468 / #450 / explorer 与 ACR ground truth，无静默假设。

## ACR Verdict（architecture-change-reviewer）

**Round 1（2026-08-16）**: `4 yes + 1 no`（complexity-anti-drift no）→ OVERALL BLOCKED。

- 4 yes: bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / minimal-change-verifier
- 1 no: complexity-anti-drift — spec Code Style 曾用 `buildWorkerToolSurface(reg.tools, ...)`，但 `AciRegistry` 只暴露 `inner/catalog/visibleSchemas`（无 `tools`），`inner` 是冻结快照，事后裁剪不可行；executor 重建路径未命名，会诱使 god-function 复制 createAciRegistry/Gate-3 逻辑。
- 整改：Code Style 改为 **def-list 期过滤**（createAciRegistry(tools) 前，registry.ts 工厂内，仿 memoryDir 条件化 + Gate 3 镜像过滤）；Project Structure / Boundaries / Success Criteria 同步；A1 修正为"机制修正不改变语义"。
  **Round 2（2026-08-16）**: `5/5 yes` → **OVERALL: PASS → hand to writing-plans**。

```
bounded-context-guardian: yes — 新边 registry.ts → subagent/role.js 无环（role.ts 只 import ../errors.js），且镜像 registry→subagent 既有边（registry.ts:38-40 已 import spawn-subagent-tool/subagent-result-tool/SubAgentManager）；无反向依赖、不碰 wire schema。
defensive-contract-validator: yes — 测试表覆盖六类：正常 / 未知名宽容 / 空/undefined/deny-all 边界 / 权限（inner+visibleSchemas 双面断言 5 禁项）/ 旧 wire 向后兼容 / 并发 N/A 有据（进程启动期一次性同步装配）。
error-handling-enforcer: yes — 宽容忽略有文档不抛；唯一新 throw = typed EXIT-documented RegistryConstructionError（Gate 3 分歧，registry.ts:260-267）；buildWorkerToolSurface 的 {name} 约束由 AciToolDef 经 ToolDef.name 满足；无新非类型化失败路径。
complexity-anti-drift: yes — Round 1 幻影 reg.tools 已除；spec 以 aci-registry.ts:18-35 仅暴露 inner/catalog/visibleSchemas 为据，明令 createAciRegistry(tools) 前裁剪（registry.ts:270）；Gate 3 镜像过滤具名（toolsetNames deny 过滤 + memoryDir excluded 数组机制 registry.ts:252-259）；无 executor 重建 god-function。残余注记：factories 键排除、excluded 数组、tools map 三方需协调（双机制幂等），Gate 3 fail-fast + SC5 兜底——guarded drift 非静默。
minimal-change-verifier: yes — 单一逻辑任务（worker 消费 disallowedTools → def-list 裁剪）、1 commit；envelope/manager/buildWorkerPayload/JUDGE_ROLE 显式不动（spec:52）；worker 缝 grounded（CreateWorkerDepsOptions 现无 disallowedTools worker.ts:68-87、runSubagentWorker 只传 env+sandboxRoot worker.ts:316-319，透传是真缺口）。
```
