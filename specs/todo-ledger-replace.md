# Spec: todo 账本 replace + 快照

> Spec issue: [#903](https://github.com/winter6205/iknow/issues/903)。图上 DP/replan：**[#904](https://github.com/winter6205/iknow/issues/904)**（回链 map #540）。实施前 PLAN 另开。
> 本文件 **不写** CONTEXT / ADR 正文；已 flush：ADR-0046、`docs/CONTEXT.md` **todo 账本**。

## ASSUMPTIONS（本轮 grilling + ADR-0046 已收；不重开）

1. 本 spec **只**改主会话 `todo_write` 的轻规划清单。图 / Dynamic Pipeline / replan **不在本合同**。
2. 开跑前写一版全局步骤合法；否决的是 Plan Mode **相位**，不是清单本身。
3. 任务变了必须能 **整表换成新现行列表**；历史以同目录快照文件保留，不当待办。
4. replace 当跳 **不**把新列表再追加进 `messages`；后续全局观仍只靠状态栏投影现行未勾项（ADR-0028）。
5. `list` / 状态栏 / `readOpenTodoLines` **只读**现行 `todos.md`，不读快照、不拼接历史。
6. add / check / list 语义不变；replace 是同一工具的新 mode，不拆第二工具。
7. worker / ask 仍不装配 `todo_write`（D6 / oneshot 剥离不动）。
8. replace 与 add/check 同为 write：默认 ask；`list` 仍 bypass ask。
9. 栈仍 TypeScript + vitest；测试命令 `npx vitest run` 相关文件 + `npm test` 回归。
10. 快照文件名实施锁定为 `todos.<unixMs>.<hex>.md`，与现行 `todos.md` 同目录（`resolveConversationTodoDir` 的父目录）。

→ 以上视为已确认。

## Glossary（exact copy from docs/CONTEXT.md）

- **状态栏**: 每次即将调模型前由 harness 算出的现势，以 **user** 消息追加在 `messages` 末尾（含同一用户回合内 tool loop）；旧栏留在历史上，不替换、不写 `deps.system`；UI 只读同一份，in-flight 只给 TUI。字段仅 `last_tool`（本回合尚未跑过工具则为 idle）以及有未勾项时才出现的 todo 段（只投影现行 todo 账本的 `- [ ]` 行；文件缺席 / 空 / 全勾则整段缺席）。ADR-0028；todo 账本见 ADR-0046。
- **todo 账本**: 主会话可修订的任务清单（`todo_write`）；允许开跑前写一版全局步骤，执行中用 replace 换成新的现行列表。现行文件是会话目录里的 `todos.md`；replace 时旧文件改名留在同目录当快照，不当待办。不是图、不是 Plan Mode、不是 Dynamic Pipeline。ADR-0046。

## Objective

主会话模型在执行中发现步骤过时时，能用 `todo_write` 的 `replace` 交出一份新的待办列表：磁盘上留下旧账本快照，现行 `todos.md` 只有新列表。工具回执仍是短字符串，不把新列表灌进 messages。成功 = 下列 Success Criteria 全绿。

## Boundaries

- **Does:**
  - `todo_write` 增加 `mode: "replace"`；入参 `items` 为字符串数组（每条变成现行账本一行 `- [ ] <item>`）。
  - 现行路径始终是 `resolveConversationTodoDir` 解析出的 `todos.md`。
  - 若现行文件存在且非空：先改名为同目录快照 `todos.<unixMs>.<hex>.md`，再原子写入新 `todos.md`。
  - 现行为空或缺席：不创建快照，只写新 `todos.md`（`items` 为空则现行变为空文件，合法）。
  - 单条仍 500 codepoints；整文件仍 64 KB；超限 typed `ToolExecutionError`，现行与已写下的快照纪律：写入失败不得毁掉已成功改名的快照，也不得留下半写的 `todos.md`（失败时现行要么仍是旧内容，要么已是完整新内容；不允许半截）。
  - schema `additionalProperties: false`；`replace` 禁止带 `item`；add/check 禁止带 `items`。
  - tool description 正面补上 replace（无负面禁令句式，D9 守门仍过）。
  - 权限：replace 走 write 默认 ask（现有 `code-allow-todo-write-list` 不匹配 replace）。
  - 单测覆盖五类边界：empty（空 `items` / 无现行文件）/ negative（非法 mode 混用字段、空字符串元素）/ overflow（单条超 500、文件超 64KB）/ concurrent（`isConcurrencySafe: false` 仍成立；同 dir 两次 replace 快照名不碰撞）/ exception（读/改名/写失败 typed error）。
- **Confirms with human:** （none — 假设门已收）
- **Out of this spec:**
  - Dynamic Pipeline、replan、改 `run_graph`、图节点共享 todo。见 [#904](https://github.com/winter6205/iknow/issues/904)，回链 map [#540](https://github.com/winter6205/iknow/issues/540)。
  - Plan Mode / `enter_plan_mode`。
  - Cursor 形态 `{ todos, merge }` 兼容层。
  - 状态栏改读规则、把快照投影进栏、replace 当跳额外 user 消息。
  - TUI 独立 todo 面板。
  - 把 verify / judge 接到 todos.md。
  - worker 注入 `todoDir`。

## Success Criteria

每条 yes/no。命令以仓库根为准。

1. **schema**：`todo_write` 的 `mode.enum` 含 `replace`，属性含 `items`（array of string）。`npx vitest run tests/harness/aci/tools/todo-write.test.ts` 退出 0。
2. **现行替换**：`replace` 且 `items: ["A","B"]` 之后，现行 `todos.md` 恰好为两行未勾 `A`/`B`；回执为 `Updated todos.md`（与 add/check 同形短字符串）。同上测试文件退出 0。
3. **快照保留**：replace 前现行非空 → 同目录存在快照文件，内容等于 replace **之前**的现行全文；`list` 返回的是**新**现行，不含快照正文。同上退出 0。
4. **栏只读现行**：replace 后 `readOpenTodoLines` 只含新未勾项，不含快照里仍开着的旧项。`npx vitest run tests/harness/agent-status*.ts tests/harness/aci/tools/todo-write.test.ts` 中覆盖该不变量的用例退出 0。
5. **权限**：`mode: "replace"` 的 `checkPermission` 为 `ask`；`list` 仍 `allow`。`npx vitest run tests/harness/permission/policy.test.ts` 退出 0。
6. **回归**：add/check/list 既有用例仍绿；`npm test` 退出 0（本 spec 新增测试含在内）。缺 LLM key 的 live 标 Not run，不挡。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- ADR-0046；ADR-0028（栏追加、只投影现行未勾行）。
- `#440` D1 单工具 + mode 枚举（本 spec **扩展** enum，不拆工具）；D2 会话目录账本；D4 64KB / 500 codepoints / 原子写；D5 短回执；D6 worker 不注入 todoDir；D7 write + list bypass ask；D8 verify 不读账本；D9 正面 description。
- `createTodoWriteTool` / `resolveConversationTodoDir` / `OPEN_PREFIX` / `TODOS_FILE`。
- 测试：`tests/harness/aci/tools/todo-write.test.ts` 及 per-conversation / e2e 夹具。
- 命令：`npx vitest run <file>`、`npm test`。

**Changes：**

- `TODO_WRITE_MODES` 增加 `replace`；输入增加 `items`。
- replace 路径：非空现行 → 改名为快照 → 原子写新 `todos.md`。

## architecture-change-reviewer

Affects（实施时，非本 docs 提交）：`src/harness/aci/tools/todo-write.ts`、`tests/harness/aci/tools/todo-write.test.ts`、`tests/harness/aci/tools/todo-write-e2e.test.ts`、`tests/harness/permission/policy.test.ts`、必要时 `tests/harness/agent-status*.ts`。

```
bounded-context-guardian: yes — 仍停在 ACI todo_write 与状态栏只读投影；不进 harness/graph、不给 worker 账本。
defensive-contract-validator: yes — Boundaries 已点名 empty / negative / overflow / concurrent / exception 五类测试。
error-handling-enforcer: yes — 超限与 IO 失败 typed ToolExecutionError；无空 catch；半写现行不允许。
complexity-anti-drift: yes — replace 为独立 mode 分支（解析 items / 快照改名 / 原子写），不把 list/add/check 缠进同一大函数。
minimal-change-verifier: yes — 一逻辑任务：replace + 快照；本步只落 spec/索引/tracker，不改产品代码。
```

## 待写入

空（ADR-0046 与 **todo 账本** 已落盘）。

## Tracker

- 本合同：[#903](https://github.com/winter6205/iknow/issues/903)；plan：`plans/todo-ledger-replace.md`（本地任务列表，无每刀 GitHub issue）
- 范围外（图上活管线）：[#904](https://github.com/winter6205/iknow/issues/904) · map [#540](https://github.com/winter6205/iknow/issues/540) · V1 [#545](https://github.com/winter6205/iknow/issues/545) / [#715](https://github.com/winter6205/iknow/issues/715)
