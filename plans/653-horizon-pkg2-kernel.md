# Plan: horizon-653 / 包2-内核（沙箱纪律 + 并行调度）

**Goal:** 后台 `bash` 与前台共用同一套沙箱纪律；同一 tool 阶段安全工具可重叠执行，不安全仍串行，结果顺序不变。
**Approach:** 先对齐围栏构造（S），再让执行器装饰层与 `runToolPhase` 按 `isConcurrencySafe` 批处理（P）。两包 G3 序：T2/T3 不得先于 T1 合入主干。三刀对应两件能力（P 拆「包装层能批」与「loop 真批」），避免只改 executor 而 loop 仍 `executeAll([one])`。
**Spec link:** `specs/653-horizon-pkg2-kernel.md`
**Tracker:** GitHub 主路径（`ready-for-agent` + 原生 blocking）。[spec #667](https://github.com/winter6205/iknow/issues/667) · [T1 #668](https://github.com/winter6205/iknow/issues/668) · [T2 #669](https://github.com/winter6205/iknow/issues/669) · [T3 #670](https://github.com/winter6205/iknow/issues/670)。T2←T1；T3←T2。
**ACR:** all-yes（自 spec）

```
bounded-context-guardian: yes — 只动 harness 执行/沙箱/ACI 装饰层；不新建 technical-layer 目录；不进 TUI 产品面、不进 graph/#540
defensive-contract-validator: yes — SC 覆盖 empty / negative（裸跑、不安全重叠、单元素 executeAll）/ overflow（≥8 安全 stub）/ concurrent（双安全重叠）/ exception（单员失败、abort、spawn_error）
error-handling-enforcer: yes — 失败走既有 ToolExecutionResult / spawn_error / cancelled；不抛裸 Error；一员失败不吞整批
complexity-anti-drift: yes — S 与 P 分列；围栏构造一缝；调度一层批处理；不把权限与并行揉成一个神函数意图
minimal-change-verifier: yes — 单逻辑任务包2-内核；S 与 P 分 commit（本 plan 切刀）；无新 ADR；不重标 isConcurrencySafe 目录
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入（persist）

（空 — `沙箱纪律` 已写入 `docs/CONTEXT.md`。无新 ADR。）

## Tasks (ordered by dependency)

1. **T1 前台/后台 bash 沙箱纪律对齐** — tag: `[implementation]`
   - **Inherits:** spec S：同一输入下 bwrap 隔离轴集合相等；产品 `background:true` 无无围栏裸跑；spawn 失败走既有 typed error；不改 ADR-0021 生命周期。
   - **Surface:** harness sandbox + `bash` + background spawn（共享围栏构造缝；不发明第三套 fence）。
   - **Acceptance:** 前台 vs 后台 argv 隔离轴相等（含 `network` / `cwdReadonly` 开与关）；产品后台路径证明走该缝；`npx vitest run tests/harness/background tests/harness/sandbox tests/harness/aci` 相关子集绿。
   - Status: [ ] pending

2. **T2 执行器装饰层对安全批可重叠** — tag: `[implementation]`
   - **Inherits:** spec P：`isConcurrencySafe: true` 可时间重叠；`false` 与任何其他调用不相交；结果顺序 = 输入 calls；`[]` → `[]`；单员失败其余仍 settle；permission/pre-hook 仍逐调用且 deny 不进并行集。
   - **Surface:** tools executor 与 ACI / permission 包装的 `executeAll`（loop 仍可暂逐个调用；本刀证明包装层接到 N 个安全 call 时会重叠）。
   - **Acceptance:** 双安全 stub 墙钟重叠；混入 unsafe 则区间不相交；顺序稳定；empty/exception 两例；既有 interrupt/timeout 契约不破。
   - Status: [ ] pending
   - [blocks: T1]

3. **T3 loop tool 阶段对连续安全 tool_use 真批处理** — tag: `[implementation]`
   - **Inherits:** spec P + #620：连续安全调用不得全部变成 `executeAll` 长度恒 1；每个结果 settle 后仍可立即上盘；`computeToolStopFlags` 不变。
   - **Surface:** Loop Engine `runToolPhase`（及它实际注入的 executor）。
   - **Acceptance:** 同回合两条安全 `tool_use` 重叠执行；结果写入顺序与 `tool_use` 顺序一致；≥8 安全 stub 全 settle 不 hang；`npx vitest run tests/harness/loop-engine tests/harness/tools tests/harness/aci` 绿。
   - Status: [ ] pending
   - [blocks: T2]

## End-of-round

全部 bullet 落地后：整轮 `arthurpower:code-review`（若环境启用）→ `verification-before-completion`。
