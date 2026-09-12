# Spec: 主代理控制面（建树工具 / 设置分层 / todo 三件事 / 打断与子代理 TUI）

> 图：`docs/wayfinder/agent-control-surface-map.md`（G1–G4 + R1–R3）。
> 下游 plan：`plans/agent-control-surface.md`。
> 本文件不写 CONTEXT / ADR 正文；待写入见文末。
> **Amends** `create-worktree-tools.md`（工具在场条件）；`todo-ledger-replace.md` / ADR-0046（账本形状与 mode）；`358-subagent-runtime-observability.md`（TUI 显示面 + 取消；该 spec 已落地，归档见 `docs/archive/025-retire-completed-specs-and-plans/specs/`）；`146-tui.md`（chrome 强杀）；设置通道（ADR-0015）加项目允许名单。

## ASSUMPTIONS（wayfinder grilling 已收；不重开）

1. 到达标志是操作员可控：建树后能进树、todo 能一次写下多步、能停前景子代理、超时不是成功。
2. 四条切片**顺序落地**（建树工具面 → 设置分层 → todo 三件事 → 打断/TUI），同一 destination，plan 里拆 tracer；禁止一个 PR 四条混交。
3. 栈仍 TypeScript + vitest；`npm test` 回归；模型可见文案先夹具（`docs/guides/prompt-development.md`）。
4. 不对标产品名进本文件。
5. 跨**主会话**共用 todo 账本不做（雾区）。
6. isolation 默认值仍 OFF（代码默认）；操作员机器用户 settings 已 ON 不在本合同。
7. 门禁仍不 auto-provision（ADR-0037 这条不撤）。
8. 默认仍前景 `wait:true`（ADR-0014）。
9. 权限机械层语义（rule DSL / allow|deny|ask / 谓词）不换成字符串列表。
10. 第三层个人 settings 文件不做。

→ 以上视为已确认。

## Glossary（exact copy from docs/CONTEXT.md）

- **worktree isolation mode**（`settings.isolation.worktreeOnMutate`，默认 OFF）: 全局隔离开关——OFF 时会话行为与今日完全一致；ON 时会话可只读主仓，写路径 mutate 被门禁拦下（门禁**从不**自动建树），由模型调 `create-worktree` ACI 工具建 task worktree（含 task 分支）并 **session worktree rebind** 到该树，此后本会话 mutate 只进该根；已绑定则放行，不建第二棵树。
- **session worktree rebind**: worktree isolation mode ON 下 `create-worktree`（或 enter / exit）ACI 工具成功后，把**当前会话**生效的根锚切到本会话 task worktree 的动作。
- **todo 账本**: 主会话可修订的任务清单（`todo_write`）；允许开跑前写一版全局步骤，执行中用 replace 换成新的现行列表。现行文件是会话目录里的 `todos.md`；replace 时旧文件改名留在同目录当快照，不当待办。
- **状态栏**: 每次即将调模型前由 harness 算出的现势……字段仅 `last_tool`……以及有未勾项时才出现的 todo 段（只投影现行 todo 账本的 `- [ ]` 行……）。
- **前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约——前景（`wait:true`，默认）= handler 同步等 worker 到终态；后景（`wait:false`）= 立即返回 task_id。
- **chrome focus**: TUI 底栏焦点环 `input` | 子代理行 | `graph` 的单一 reducer；有子代理行时 Down 先入该列，再 graph；Up 反向回到输入框。
- **session location chrome（会话位置行）**: TUI 底栏常驻一行……子代理行在它下面；不进模型消息。

## Objective

让主代理在「多步改代码」会话里走一条可判定的控制面：工作树工具不跟隔离开关捆死；项目 settings 只承载团队契约（含权限规则）；todo 按条 id 做添加 / 更新 / 读取，子代理与父共用一份账本；操作员能取消前景等待并在 TUI 看见、选中、强杀子代理。成功 = 下列 Success Criteria 全绿。

## Boundaries

### Slice A — 工作树工具在场

- **Does:**
  - isolation **OFF** 时主会话仍注册 `create-worktree` / `enter-worktree` / `exit-worktree` / `list-worktrees` / `remove-worktree`（host 缝在场即可，不再要求 `isolationEnabled`）。
  - isolation **ON** 时 mutate 门禁行为与今日一致（未绑树写主仓拦下，回执点名 `create-worktree`；从不自动建树）。
  - OFF 时无门禁：主仓可写；模型仍可用 create/enter 改绑（成功则下一波 cwd 在树）。
  - `git worktree add` 经 bash 仍**不是** rebind。
- **Out of this spec:** 改代码默认 ON；auto-provision；占用锁 ADR-0070。

### Slice B — 用户层 vs 共享项目 settings

- **Does:**
  - 两层文件不变：`~/.iknow/settings.json`（用户）与 `<仓>/.iknow/settings.json`（共享项目）。无第三层 local。
  - **项目允许名单**：项目文件只采纳 `hooks`、`verify`、`secrets`、`permissions`。其余顶层段（`isolation` / `llm` / `subagent` / `web` / `lsp` / `memory` / `loop` / `graph`）出现在项目文件 → **丢弃、不覆盖用户值**，启动可见警告。
  - 面板 / 写回：用户层键只写用户文件；不得因「项目文件已存在」把 thinking 等写入项目。
  - **权限搬家**：现有 `permissions.toml` 的 `schema_version` + `rule` DSL 迁入项目 settings 的 `permissions`；**停读 toml**；两份同时存在 → 启动 fail-loud。用户层不接 `permissions`。
- **Out of this spec:** 托管/MDM 层；把权限做成 allow 字符串列表。

### Slice C — todo 三件事

- **Does:**
  - 现行账本每条有稳定 **id**；状态 `pending` | `in_progress` | `completed`（删除走更新，不当第四态进栏）。
  - 三件事（可仍是一把工具的 mode，或拆注册名；对外契约按三件事验收，不强制四件 ACI）：
    - **添加**：一次可多条；追加不覆盖；回执含新 id。
    - **更新**：按 id 改 subject / status / 删除。
    - **读取**：列出现行（id / subject / status）。
  - 子代理与父会话共用**同一会话**账本：worker 可 **读取** 与 **更新**；**添加仅父会话**。worker `add` → typed 拒绝（非静默丢弃、非「工具不在场」）。
  - `check` 收进更新（status=completed）。`replace` 降为整表作废逃生口（或 `reset`），不是换计划主路径。
  - 状态栏仍只投影未完成项；格式可从 `- [ ]` 迁到带 id 的投影，**不**把整表灌进 messages。
- **Out of this spec:** 跨主会话共用账本；依赖边；TUI 独立 todo 面板；verify 读账本。

### Slice D — 打断与子代理 TUI

- **Does:**
  - `/quit`：先 abort 当前前台 turn，再等收尾；不等子代理 per-task 墙钟。
  - 前台 Ctrl+C：`running-fg` 必须 abort wait（`spawn_subagent` cancel 链）。有选区可先复制，须可感知；再按或 Esc 取消 turn。
  - 子代理墙钟到期：父可见 envelope / `tool_kind` **不得**为成功 ok。
  - 会话消息内：每个活子代理两行——`{role} running...` + 下一行 dim 最新内容（taskPreview / 最近工具）。
  - 输入框下概览：沿用 `● ○` 与 chrome-focus；聚焦行 `> `；**Ctrl+X** 强杀聚焦子代理；父 turn 收到 cancelled。无 Enter 进子代理会话。无第二套 picker 文案。
- **Out of this spec:** 默认改 `wait:false`；给 `timeoutMs` 加硬帽（可另开）。

- **Confirms with human:** (none)

## Success Criteria

每条 yes/no。命令以**本 worktree 仓库根**为准。

**A 建树**

1. isolation OFF 时 registry 含 `create-worktree` 与 `list-worktrees`。`npx vitest run tests/harness/aci/tools/registry.test.ts tests/session-api/hub-worktree-isolation.test.ts`（及本切片新增用例）退出 0。
2. isolation ON + 未绑树 + 写主仓 → 门禁拦，回执含 `create-worktree`。既有 isolation 测试仍绿。
3. bash `git worktree add` 成功不改变 `taskRoot`（无 rebind）。新增或既有门禁测试退出 0。

**B 设置**

4. 项目文件含 `isolation` / `llm.model` 时，合并结果等于用户层值，且有警告通道可测。`npx vitest run tests/config/settings.test.ts` 退出 0。
5. 仅项目 `permissions.rule` 时，策略层能加载与今日 toml 同形的一条 deny/allow。toml 与 json 并存 → 启动/加载 typed fail。`npx vitest run tests/harness/permission/project-settings.test.ts tests/config/settings.test.ts` 退出 0。
6. 写回 thinking 不创建/不改项目文件里的 `llm`（项目文件缺席或在场皆然）。TUI/settings 写回相关测试退出 0。

**C todo**

7. `add` 一次多条 → 现行 N 条 pending，回执含 N 个 id。`npx vitest run tests/harness/aci/tools/todo-write.test.ts` 退出 0。
8. `update` 按 id 改 status/subject；错误 id typed error。同上退出 0。
9. worker 工具面能读与更新父会话账本；worker `add` typed 拒绝；两会话 id 不串。相关 worker / todo 测试退出 0。
10. 状态栏只投影 pending/in_progress，不含 completed。`npx vitest run tests/harness/identity/agent-status-read-rule.test.ts`（或现行栏测试）退出 0。
11. **empty / overflow（C）**：空 `add`（空数组 / 空 subject）typed 失败、现行不变；超限额（Inherits：64KB / 500）typed 失败、不半写。同上 todo 测试退出 0。

**D 打断 / TUI**

12. `/quit` 在 `wait:true` spawn 期间会 abort（单测或桥接测：quit 路径调用 abort，不等 2h）。相关 TUI 测试退出 0。
13. 超时 envelope 不是 ok。`npx vitest run tests/subagent/spawn-subagent.test.ts`（及新增）退出 0。
14. 消息内两行投影 + 面板 `>` + Ctrl+X 触发强杀的纯函数/键位测退出 0。`npx vitest run tests/tui/subagent-panel.test.ts tests/tui/chrome-focus.test.ts`（及新增）退出 0。
15. **empty（D）**：无 chrome 聚焦子代理时 Ctrl+X 不杀、不崩；无选区且 `running-fg` 时 Ctrl+C abort wait。相关 TUI 测试退出 0。
16. **回归**：`npm test` 退出 0。真模型夹具缺 key → Not run，不挡。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- ADR-0037（不 auto-provision；rebind 只经 ACI 缝）；ADR-0069 / 0079 / 0082（告知面 vs 回执点名；工具名）。
- ADR-0014（默认 wait:true）；ADR-0015（settings 双文件）；ADR-0084（项目层只采纳允许名单 `hooks` / `verify` / `secrets` / `permissions`，其余顶层段丢弃 —— Slice B 即兑现）。
- ADR-0028（栏追加、不灌整表进 messages）；`0046-todo-ledger-replace-and-snapshots` 的快照/不灌 messages；**形状与三件事见 ADR-0085**（64KB/500 仍 Inherits）。
- `#440` D6 今日 worker 无 todoDir——Slice C **改**为共用账本，见 Changes。
- chrome-focus / SubagentPanel `● ○` / `> ` / identity strip（Slice D 叠加强杀与消息两行）。
- 权限 toml loader + 谓词 DSL（迁 JSON，语义不变）。
- 命令：`npx vitest run <file>`、`npm test`、`docs/guides/prompt-development.md` 夹具纪律。

**Changes：**

- 工作树工具装配与 `isolationEnabled` 解耦。
- 项目 settings 允许名单 + 权限进 `permissions` + 停读 toml + 写回落对层。
- todo：id、三件事、`add` 可多条、`check` 并入更新、`replace` 降级、worker 可见同一账本。
- `/quit` abort；超时非 ok；消息 running 两行；Ctrl+X 强杀。

**待写入：**

空（2026-09-11 已 flush：ADR-0037 amendment、ADR-0084、ADR-0085、CONTEXT）。

## architecture-change-reviewer

```
bounded-context-guardian: yes — 四切片落在既有 harness/config/tui/permission，不新开顶层技术层目录；plan 按切片顺序，禁止一轮混改四条。
defensive-contract-validator: yes — SC11 empty/overflow（空 add、限额）；SC8 未知 id；SC9 两会话不串；SC5 双文件；SC13/15 超时非 ok + 无聚焦 Ctrl+X / 无选区 Ctrl+C。
error-handling-enforcer: yes — worker add typed 拒绝（SC9，非静默丢弃）；权限双文件 fail-loud；超时/取消 typed 非 ok；未知 id typed。
complexity-anti-drift: yes — 四切片分 PR/分 bullet；todo 从 mode 堆叠扩到三件事须拆 helper，禁止单文件神函数。
minimal-change-verifier: yes — 一个 destination、plan 四切片；本 spec 不含跨会话 todo、不含默认 isolation ON、不含 wait:false 默认。
```
