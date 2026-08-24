# Spec: horizon-653 / 包2-内核（沙箱纪律 + 并行调度）

> Wayfinder map: [#653](https://github.com/winter6205/iknow/issues/653) · G3 包2 · Assumptions 沿用 G3/G4/G5（2026-08-24 ratified）；操作员授权直接 SPECIFY→PLAN（跳过现场 assumption 盘问）。

## Objective

让单 agent 在 **harness 内核**上收口 G3 包2：后台 `bash` 与前台遵守同一套 **沙箱纪律**；同一助手回合内多条 `tool_use` 的调度尊重 ACI `isConcurrencySafe`（安全可重叠，不安全仍串行）。

用户：所有走 `Loop Engine` 的入口（TUI / chat / ask / serve）。成功 = 无「后台裸跑」产品路径；安全工具在同一 tool 阶段可同时在飞；结果顺序与模型给出的 `tool_use` 顺序一致；#620 的「结果一到就上盘」仍成立。

## Boundaries

- **Does:**
  - **沙箱纪律（S）**：同一 `bash` 调用输入（cwd、`network`、`cwdReadonly` / `bashMode=readonly`、workspaceRoot）下，前台 `runInSandbox` 与 `background:true` spawn 的 bwrap 围栏参数同集（FS 白名单、网络轴、env 隔离、rlimit、cwdReadonly）。后台仍 detached 生命周期（ADR-0021），**不**改成等待前台 `runInSandbox`。
  - **无裸跑产品路径**：装配了 background manager 的产品 `bash` 不得在无 bwrap argv 的情况下 `detached` spawn。测试/DI 仍可注入 fake spawn。
  - **并行调度（P）**：`runToolPhase` 不得再对 **全部** `isConcurrencySafe: true` 的连续调用逐个 `executeAll([one])`。同一阶段内，安全工具允许时间重叠；`isConcurrencySafe: false` 的调用与任何其他工具调用不得重叠。
  - **顺序**：返回给 adapter / JSONL 的 `tool_result` 顺序 = 该回合 `tool_use` 顺序。
  - **#620**：每个结果 settle 后仍可立即 `commitMessages`（不必等整批）；并行只改变启动重叠，不改「一条 user 消息里多块」的既有编码。
  - **权限 / 钩子**：并行启动前仍逐调用走既有 pre-hook → permission → inner；deny/hook-block 的调用不进入并行集。
  - **失败态（typed / EXIT）**：
    - `executeAll([])` → 空数组（EXIT：empty）。
    - 一批中单个 `execution_failed` / `validation_failed` → 其余仍跑完；不因一员失败 abort 整批（EXIT：exception isolation）。
    - 调用方 `signal` abort → 在飞调用走既有 cancelled；`computeToolStopFlags` 契约不变（EXIT：cancelled）。
    - 后台 spawn 围栏构造/spawn 失败 → 既有 `spawn_error` / `ToolExecutionError`，不抛裸 `Error`（EXIT：degraded/fail-closed 沿用 ADR-0021）。
    - 缺 background manager + `background:true` → 既有 fail-fast `ToolExecutionError`（不变）。
- **Confirms with human:** （已收）S→P 交付序；不并 #440；不改 Graph/#540。
- **Out of this spec:**
  - 包1 感知（已合 PR #666）。
  - 语义 AST shell、持久交互 PTY、sidecar（G5 defer）。
  - `#440` bash 服务/任务**产品面**；本 spec 只对齐沙箱窄切片。
  - `#540` 多子代理并行；`spawn_subagent` 前景/后景契约（ADR-0014）不改。
  - 为并行新造超时/截断权威（契约 X / ADR-0005 / ADR-0006 不动）。
  - 语义改 `isConcurrencySafe` 各工具现有 true/false（本 spec 只**消费**旗帜，不重标目录）。

## Success Criteria

```bash
npm run typecheck
npx vitest run tests/harness/tools tests/harness/aci tests/harness/background tests/harness/sandbox tests/harness/loop-engine
```

每条 yes/no：

- 同一 fixture 输入下，前台与后台 bwrap argv 在隔离轴上集合相等（network / cwdReadonly 开与关各至少一例）（positive）。
- 产品 `bash` `background:true` 路径的 spawn argv **包含** bwrap（或测试替身证明调用了与前台同一围栏构造缝）；不存在「仅 `nodeSpawn(command)` 无围栏」的产品分支（negative）。
- 两个 `isConcurrencySafe: true` stub 在同一次 tool 阶段墙钟重叠（concurrent）；结果数组顺序与输入 calls 一致。
- `isConcurrencySafe: false` stub 与另一调用的执行区间不相交（negative / concurrent）。
- `executeAll([])` 返回 `[]`（empty）。
- 一批两调用：第一个 handler throw → 对应 `execution_failed`，第二个仍有结果（exception）。
- 超长并行输入：≥8 个安全 stub 仍保持顺序且全部 settle；不 hang（overflow；不强制新并发上限除非沿用既有 manager 上限）。
- `runToolPhase` 源码/测试：连续安全 `tool_use` 不再全部变成 `executeAll` 长度恒为 1（negative：#620 逐调用驱动对安全批不再是唯一路径）。
- `npm run typecheck` 与上列 vitest 子集 exit 0。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- 栈：TypeScript；`npm test` / vitest；无本 spec 强制新依赖。
- 沙箱：`specs/security-guardrails.md`（#123 bwrap）；ADR-0021（后台生命周期、`--die-with-parent`、detached 进程组）。
- 执行器：ADR-0005 停止信号；契约 X 截断权威（CONTEXT **executor truncation authority**）。
- ACI `isConcurrencySafe` 已在各工具 `aci` 块上；loop 今日 `runToolPhase` 逐调用 `executeAll([one])`（#620 T3）。
- CONTEXT 现行抄录（exact）：
  - **Loop Engine**: Foundation 的状态机运行内核，驱动模型 -> 工具 -> 真实结果 -> 下一轮模型 -> 明确停止；位于 `src/harness/`，作为 018 退役旧 loop 后的可靠运行时基础。
  - **ToolExecutionContext**: Executor 透传给 handler 的执行上下文 `{ signal }`；run 第三参 signal 原样透传、不创建子 signal，超时由 Executor `Promise.race` 外包而非 ctx 携带。
  - **in-flight closeout**: abort/timeout/进程死亡时的收尾——live：模型在途则整回合不进历史；工具在途则 assistant 已追加，在途 tool 填 `execution_failed`（`"cancelled"` / `"timeout"`），再编码为 tool_result。signal 优先于 timeout。
  - **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段，executor 永不信任工具声称的截断字段（防 MCP 第三方伪造绕过封顶）。#140 裁决，ADR-0004 / ADR-0006。
  - **前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`，显式选项）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程，与前景/后景正交。
- 邻图：#653 G4 — 本路线 own S/P；#440 own bash 产品；#540 无关。

**Changes：**

- 后台与前台 `bash` 围栏参数对齐（共享构造缝；生命周期仍 ADR-0021）。
- 产品 tool 阶段按 `isConcurrencySafe` 批处理；改写「executor / ACI / permission / loop 一律单调用串行」中**调度**这一层（权限判定仍逐调用）。
- 待写入（persist）：CONTEXT **沙箱纪律**；**无新 ADR**（不改 0021 / 0005 条款，只消缺口）。
- 索引：`specs/README.md` 活跃表增加本文件一行。

## architecture-change-reviewer

预定接线（实施前 ACR）：

- `src/harness/aci/tools/bash.ts`、`src/harness/background/manager.ts`、`src/harness/sandbox/**`（围栏构造缝）
- `src/harness/tools/executor.ts`、`src/harness/aci/aci-executor.ts`、`src/harness/permission/permission-executor.ts`、`src/harness/loop-engine.ts`（调度）
- `tests/harness/{tools,aci,background,sandbox,loop-engine}/**`
- `specs/653-horizon-pkg2-kernel.md`、`specs/README.md`、`docs/CONTEXT.md`

```
bounded-context-guardian: yes — 只动 harness 执行/沙箱/ACI 装饰层；不新建 technical-layer 目录；不进 TUI 产品面、不进 graph/#540
defensive-contract-validator: yes — SC 覆盖 empty / negative（裸跑、不安全重叠、单元素 executeAll）/ overflow（≥8 安全 stub）/ concurrent（双安全重叠）/ exception（单员失败、abort、spawn_error）
error-handling-enforcer: yes — 失败走既有 ToolExecutionResult / spawn_error / cancelled；不抛裸 Error；一员失败不吞整批
complexity-anti-drift: yes — S 与 P 分列；围栏构造一缝；调度一层批处理；不把权限与并行揉成一个神函数意图
minimal-change-verifier: yes — 单逻辑任务包2-内核；S 与 P 分 commit（plan 切刀）；无新 ADR；不重标 isConcurrencySafe 目录
```

**persist：** `沙箱纪律` 随本分支写入 `docs/CONTEXT.md`。无新 ADR。
