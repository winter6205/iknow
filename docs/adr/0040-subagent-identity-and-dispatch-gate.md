# 0040. 子代理身份与按能力派发门禁

Date: 2026-08-31

Status: accepted

> 本 ADR 是对 ADR-0037 §2 子代理条款的补充与收窄。ADR-0037 继续管辖
> worktree isolation mode 的开关、创建、改绑和失败语义；涉及子代理根归属、
> 双重 conversationId 与派发门禁时，以本 ADR 为准。

## Context

本次核验确认，ADR-0037 §2 已经规定「子代理 spawn 自父会话，跟随父会话改绑后的同一棵树，不触发第二棵树」（`docs/adr/0037-worktree-isolation-on-mutate.md:27-29`）；`docs/CONTEXT.md` 也已有父会话改绑后 spawn 的子代理继承该根、不另建树的描述（`docs/CONTEXT.md:350`）。因此这里不是从零定义 worktree 继承规则，而是把该句未展开的身份、会话标识和门禁边界写成独立合同。

现有术语已经区分声明工具面与 worker 装配后的实际工具面，且要求二者相等（`docs/CONTEXT.md:98`）。隔离开关 ON 时，若只按 `subagent_type` 角色名判断，catalog 扩展或自定义角色会把真实可写能力与门禁结论分离；若把每个子代理当成独立隔离单元，又会破坏父会话对同一 task worktree 的统一编排。

## Decision

### 1. 子代理的身份与根归属

子代理身份 = **父会话的执行臂**，不是一个拥有独立工作区的平行会话。它与父会话共享同一棵 task worktree，并继承父会话当前生效根：

- 父会话已经 rebind 到 task worktree 时，子代理使用这同一棵 task worktree，不再创建第二棵树。
- 父会话尚未 rebind 时，满足只读门禁的子代理可以留在主仓执行只读工作；这仍不授予它独立根，也不改变父会话后续 rebind 的归属。
- 子代理写能力是否触发父会话的既有 worktree 门禁，由第 3 节按有效工具面判定；门禁触发后，子代理跟随父会话完成 rebind，不自行拥有另一棵树。

### 2. 双重 `conversationId` 身份

同一子代理调用同时存在两层身份，不能用一个 ID 混代：

- **manager 层**使用父会话的 `conversationId`。它表示谁派出了 worker，并用于该父会话的 mailbox、host drain、wake 和结果归属。
- **worker / LoopEngine 层**使用该 worker 自己的 `conversationId`。它表示子代理自身的 trace、运行状态和回合执行身份，避免不同 worker 的运行记录碰撞。

因此，父 ID 负责父侧路由与归属，worker ID 负责子侧执行与观测；二者的分工不因前景/后景 spawn 改变。

### 3. 派发门禁：按有效工具面能力推导

判据按**有效工具面能力**推导，**不按角色名匹配**。只有下列两维同时成立，子代理才允许留在主仓只读运行：

1. 有效工具面不含 `write_file`，也不含 `edit_file`；
2. 有效工具面不含 `bash`，或该角色 `bashMode === "readonly"`。

任一维不成立，即判为会写：隔离 ON 且父会话仍在主仓时，按 ADR-0037 既有门禁拦截并触发 task worktree 创建/改绑流程；隔离 OFF 时保持既有关闭档行为。判据结果必须同时保留结论与未通过维度，供门禁消息和诊断使用。

`bashMode` 只以角色 catalog 的定义为准；父代理的 `disallowedTools` 不能把 `bashMode: "any"` 变成 `"readonly"`。未知角色按 fail-closed 处理，`bashMode` 取保守的 `"any"`，因此判为会写并拦截。

## Rejected alternatives

### (a) 每个子代理建立独立 worktree

否决。子代理是父会话的执行臂，不是独立任务所有者；另建 worktree 会把同一任务的写入拆成多棵树，使父会话的 task worktree、结果路径和后续工具调用失去单一归属，还会引入合并、回收和权限授权的新协议。ADR-0037 已明确禁止子代理触发第二棵树，本 ADR 将其身份含义固定下来。

### (b) isolation ON 时子代理一律只读

否决。该方案会让合法的实现型子代理无法完成父会话委托的工作，迫使父会话重新实现或增加额外搬运回合，失去派发的价值。只读能力应按有效工具面放行；真实具备写能力的角色则由第 3 节拦截并让父会话完成既有 rebind，而不是把所有角色粗暴降级为只读。

## Consequences

### Positive

- 父会话和子代理共享一个明确的 task worktree 归属，不产生隐式第二棵树。
- 父侧 mailbox/drain/wake 与子侧 LoopEngine trace 各有稳定 ID，结果路由和运行观测不互相污染。
- catalog 增加角色或工具时，门禁仍按实际能力工作；未知角色 fail-closed，避免角色名白名单漏放可写能力。

### Negative / Trade-offs

- 一个 spawn 需要同时维护父路由 ID 与 worker 执行 ID，诊断和 trace 查询必须明确层次。
- isolation ON 下，写能力子代理首次派发可能先触发父会话的 worktree 门禁，再在新根上重派；只读子代理则可直接留在主仓。
- 有效工具面的计算必须与 worker 装配共用同一来源，否则声明面与实际面漂移会改变门禁结论。

## Reversibility

若未来要允许子代理拥有独立 worktree，必须另立 ADR，明确结果合并、权限授权、生命周期和父可见路径协议；不能把本 ADR 的共享根语义静默改成每子代理一棵树。若角色工具面模型改变，也必须同时更新两维判据和 fail-closed 规则。

## Evidence

- `docs/adr/0037-worktree-isolation-on-mutate.md:27-29`：既有 ADR-0037 §2 已定义子代理继承父会话改绑后的同一棵树、不触发第二棵树。
- `docs/CONTEXT.md:98`：既有「声明工具面 vs 实际工具面」术语。
- `docs/CONTEXT.md:344`：既有 `session worktree rebind` 术语已写明父会话改绑后 spawn 的子代理继承该根。
- `src/harness/subagent/spawn-subagent-tool.ts:277-281`：spawn 将当前上下文的父会话 `conversationId` 写入子代理定义。
- `src/harness/subagent/worker.ts:415-419`：worker 的 trace 装配使用自身生成的 `conversationId`。
