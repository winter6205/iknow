# Plan: todo 账本 replace + 快照

**Goal:** 主会话 `todo_write` 能整表换成新现行清单，旧账本留同目录快照；`list` 与状态栏只看见现行未勾项。
**Approach:** 先打通 replace 主路径（schema / 写现行 / 改名快照 / 短回执 / 权限 ask），再收五类边界与快照名不撞，再证明栏不读快照，最后 e2e 回归 add/check/list。不碰 `run_graph`、不灌 messages、不开 Plan Mode。
**Spec link:** `specs/todo-ledger-replace.md`
**Tracker:** 本地 markdown（operator 明确不要为本 plan 开 GitHub 每刀 issue）。依赖边只写在本文件 `[blocks:]`。背景指针：spec [#903](https://github.com/winter6205/iknow/issues/903)、图 DP [#904](https://github.com/winter6205/iknow/issues/904) — 不是本 plan 的 tracer ticket。误开的 #905–#908 已关。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch. 整轮结束后再 code-review，不在每刀重复。

## 待写入

空。

## ACR

Affects（实施时）：ACI `todo_write`、permission policy 测试、agent-status 投影测试、既有 todo e2e。

```
bounded-context-guardian: yes — 仍停在 ACI todo_write 与状态栏只读投影；不进 harness/graph、不给 worker 账本。
defensive-contract-validator: yes — Boundaries 已点名 empty / negative / overflow / concurrent / exception 五类测试。
error-handling-enforcer: yes — 超限与 IO 失败 typed ToolExecutionError；无空 catch；半写现行不允许。
complexity-anti-drift: yes — replace 为独立 mode 分支（解析 items / 快照改名 / 原子写），不把 list/add/check 缠进同一大函数。
minimal-change-verifier: yes — 每条 tracer bullet 一逻辑任务一提交；本 plan 四刀，不混图 DP。
```

## Tasks (ordered by dependency)

1. **replace 主路径：现行列表 + 快照 + ask** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC3、SC5；ADR-0046；`#440` D1 扩 enum 不拆工具、D5 短回执 `Updated todos.md`、D7 write 默认 ask、D9 正面 description。`items` 每条写成 `- [ ] <item>`。非空现行先改名为 `todos.<unixMs>.<hex>.md` 再原子写新 `todos.md`。空/缺席现行不建快照。
   - **Surface:** ACI `todo_write`、permission code 层（list bypass 规则不得误放行 replace）
   - **Acceptance:** `replace` + 两元素 `items` 后现行恰好两行未勾；若先前有内容则同目录快照内容等于旧全文；`list` 只返回新现行；回执短字符串；`checkPermission` 对 replace 为 `ask`、对 list 仍 `allow`。守卫该行为的 vitest 退出 0。
   - Status: [ ] pending

2. **replace 合同边：五类输入 + 快照名不撞** — tag: `[implementation]`
   - **Inherits:** spec Boundaries 五类：empty（空 `items` / 无现行文件）/ negative（`replace` 带 `item`、add/check 带 `items`、空字符串元素）/ overflow（500 codepoints / 64 KB）/ concurrent（`isConcurrencySafe: false`；同目录两次 replace 快照文件名不碰撞）/ exception（读、改名、写失败 typed `ToolExecutionError`；失败后现行不是半截文件）。
   - **Surface:** 同一 `todo_write` 工具面
   - **Acceptance:** 五类各至少一条失败或合法空路径可观测；两次 replace 得到两个快照文件；超限与 IO 失败不留下半写 `todos.md`。相关 vitest 退出 0。
   - [blocks: T1]
   - Status: [ ] pending

3. **状态栏只投影现行未勾项** — tag: `[implementation]`
   - **Inherits:** spec SC4；ADR-0028；CONTEXT **todo 账本 vs 状态栏**：栏只读现行 `todos.md` 的 `- [ ]`，不读快照、replace 当跳不另灌 messages。
   - **Surface:** agent-status 投影（只读，不改栏追加纪律）
   - **Acceptance:** replace 后 `readOpenTodoLines` 只有新未勾项，快照里仍开着的旧项不出现。覆盖该不变量的 vitest 退出 0。
   - [blocks: T1]
   - Status: [ ] pending

4. **e2e 与 add/check/list 回归** — tag: `[implementation]`
   - **Inherits:** spec SC6；per-conversation 隔离与既有 e2e 夹具仍成立；worker/ask 仍不装配本工具。
   - **Surface:** 既有 todo e2e / per-conversation 测试 + 全量 `npm test`
   - **Acceptance:** 既有 add/check/list 用例仍绿；replace 在真实 conversationId 路径上可跑通；`npm test` 退出 0。live LLM Not run 不挡。
   - [blocks: T2, T3]
   - Status: [ ] pending
