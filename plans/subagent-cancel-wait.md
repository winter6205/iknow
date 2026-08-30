# Plan: 子代理取消等待 — mailbox 回传 + 事件驱动唤醒

**Goal:** 父代理可显式后景 spawn 后继续干活；worker 终态经 mailbox 投递、host 在 chat / tui / serve 自发起 `run()` 交回浓缩结果——不编造、不依赖用户再打一行。默认仍前景 spawn。
**Approach:** 先把术语与 ADR-0014 的延期承诺收成合同；再把 host drain 从「下一轮堵等到终态」改成「有终态才浓缩」；然后接上终态事件与三入口静默 `run()`；最后改工具说明，并锁住唤醒失败的降级。graph / coordinator / 运行中互投 / 改默认 wait 不在本轮。
**Spec link:** 无。操作员跳过独立 spec；已决合同写在各票 **Inherits**。
**Tracker:** 操作员指定计划文件不写 GitHub issue；本文件随 PR 合入即为票单 SSOT。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

affects: plans/subagent-cancel-wait.md
affects: docs/CONTEXT.md
affects: docs/adr/0014-subagent-foreground-spawn-default.md

## ACR

```
bounded-context-guardian: yes — 浓缩与 mailbox 留在 harness/subagent；静默 run() 只接 chat / tui / session-api 既有 host 边界；不新建 controllers/services 技术层；不把 graph overlay 拉进本轮
defensive-contract-validator: yes — 公开行为覆盖 empty（无终态立刻空返）/ negative（ask 无 manager）/ overflow（多 worker 同时终态）/ concurrent（父回合进行中终态到达）/ exception（waitFor 拒绝、注入失败）
error-handling-enforcer: yes — drain 仍永不抛；唤醒失败走真实降级状态，禁止空 catch、禁止把空结果写成成功交差
complexity-anti-drift: yes — 浓缩、订阅终态、自发起 run() 分票；禁止把等待循环、注入语义、工具说明揉进同一函数/同一 commit
minimal-change-verifier: yes — 下表一票一逻辑任务一 commit；禁止与 graph / coordinator / 改默认 wait 同 commit
```

## 待写入

- [x] CONTEXT：`mailbox`；修订 `host drain`（本 PR 与计划同落）
- [x] ADR-0014 Amendment：事件驱动唤醒不再暂缓，兑现为本计划范围（本 PR 同落）

## Out of scope

- graph mode / `run_graph` / coordinator / 子↔子 messaging
- mailbox 承载运行中中间消息
- 把默认契约改成后景 spawn
- ask 入口装配 manager / 静默唤醒
- pipe 作为本轮验收（无下一轮用户输入的进程，不在三入口静默唤醒合同内）
- 静默纪律引导长文案、watcher 永不终止的 watchdog 数值、serve 多会话 mailbox 维度（仍 coarse）

## Tasks (ordered by dependency)

1. **记录取消等待合同（术语 + ADR 兑现）** — tag: `[decision]`
   - **Inherits:** 产品面 = 现有后景 spawn 升成真可用，不加斜杠、不加新用户可见工具；默认仍前景；mailbox 只投终态；host drain 保留浓缩、去掉 run() 边界为终态而做的阻塞等待
   - **Surface:** `docs/CONTEXT.md`、`docs/adr/`
   - **Acceptance:** CONTEXT 有 mailbox，host drain 定义不再要求「下一轮堵等到至少一个终态」；ADR-0014 写明该延期项由本计划兑现；本 commit 不改运行时代码
   - Status: [x] done

2. **仅 running 时 drain 立刻空返** — tag: `[implementation]`
   - **Inherits:** 已有 completed → 立刻浓缩（格式仍为现有 Sub-agent 前缀）；仅 running / 无任务 / 无 manager → 立刻空串，不在本次 `run()` 边界轮询等待；不修改 manager buffer
   - **Surface:** `src/harness/subagent`（host drain）
   - **Acceptance:** 后景 spawn 之后立刻再开一轮父 `run()`，该轮不因仍在跑的 worker 被拖住；worker 已终态时该轮 priorMessages 仍带浓缩结果；既有 drain 永不抛 仍成立
   - Status: [ ] pending
   - [blocks: T1]

3. **终态进入 mailbox，host 可订阅** — tag: `[implementation]`
   - **Inherits:** mailbox = 子→父终态投递箱；只写终态浓缩所需的事实；不是运行中消息总线；manager buffer 生命周期不变
   - **Surface:** `src/harness/subagent`（manager / 回传通道）
   - **Acceptance:** worker 到 completed 或 failed 后，host 不必再 poll drain 也能得知「有终态可取」；重复订阅不会改 buffer 里的信封
   - Status: [ ] pending
   - [blocks: T2]

4. **chat / tui / serve 终态后自发起 run()** — tag: `[implementation]`
   - **Inherits:** 三入口在会话空闲时可静默 `run()`，把 drain 浓缩文本拼进 priorMessages；用户不必再打一行；ask 不装配；注入不得改 goal / taskFocus；TUI 不把该条当作用户键入历史
   - **Surface:** CLI chat、TUI、session-api（既有 `run()` 边界）
   - **Acceptance:** 后景 spawn 后父代理能继续当前回合；worker 终态后同一会话自动再跑一轮且模型能看见浓缩结果；该轮没有新的用户键入；verify 输入不含这条注入
   - Status: [ ] pending
   - [blocks: T3]

5. **后景 spawn 主路径说明改为叫醒而非轮询** — tag: `[implementation]`
   - **Inherits:** 工具描述与父侧引导与已落地行为一致；`subagent_result` 仍可查询，但不是 chat / tui / serve 的完成主路径
   - **Surface:** `src/harness/subagent`（spawn 工具说明）+ 既有 identity 装配若需一句纪律
   - **Acceptance:** 后景 spawn 的说明不再把「必须轮询直到结束」写成主路径；前景默认阻塞等待的说明不变
   - Status: [ ] pending
   - [blocks: T4]

6. **唤醒失败只降级、不编造** — tag: `[implementation]`
   - **Inherits:** 有真实信封则把失败/降级交给父代理；watcher 或注入失败时禁止写成「子代理已成功交差」；drain 永不抛
   - **Surface:** `src/harness/subagent` + 三入口静默 `run()` 的失败分支
   - **Acceptance:** 注入失败或 watcher 不可用时，父侧看到的是真实未送达/可查询状态，而不是成功摘要；无信封时不得捏造成完成
   - Status: [ ] pending
   - [blocks: T4]
