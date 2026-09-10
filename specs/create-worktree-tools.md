# Spec: 工作树 ACI 改名与说明书分层

> 下游 plan：`plans/create-worktree-tools.md`。
> LogicSync 2026-09-10；ADR-0082。
> **Amends** `task-worktree-lifecycle.md` 模型面工具名；门禁分类与 unbound 回执仍属既有 spec / ADR-0069。
> **Amends** `git-work.md` 纪律段点名的工具名。

## Objective

模型面工作树工具先服务 agent：注册名是 `create-worktree` 一族，description 只说做什么。拦截点名是 harness 回执；人喊创建是提示词 + 黄金夹具。使用者是主代理（能否调对工具）和操作员（说「建树」要对上 create）。

## Boundaries

- **Does:**
  - **D1 注册名**：`create-task-worktree` → `create-worktree`；`enter-task-worktree` → `enter-worktree`；`exit-task-worktree` → `exit-worktree`；`remove-task-worktree` → `remove-worktree`；`list-task-worktrees` → `list-worktrees`。handler / 门禁 hint / TUI 注册表 / git-work 段同步。旧名不进模型面。
  - **D2 description**：五件只写能力（建树并改绑 / 进入 / 退出 / 列出 / 删树 + 可选 `name`）。禁止 `[worktree_isolation]`、禁止「先 list」、禁止「何时该调」政策。
  - **D3 闸仍在 harness**：写被拦回执点名 **`create-worktree`**（改 hint 字符串）。告知面仍不点名（ADR-0069 / 0079）。门禁仍不自动建树。
  - **D4 夹具**：固定输入 + 可判定首工具。人说创建且隔离 ON、未绑树 → 首工具 `create-worktree`。人说「有哪些工作树」→ `list-worktrees`。夹具跟 ACI 测试放，不另开总柜。先夹具再改文案（`docs/guides/prompt-development.md`）。
  - **D5 TUI 显示名**：accent / 注册表随 D1 改名；人读过程行用新名。不在本票做过程标题/10 行预览（那是 `tui-human-display`）。
- **Confirms with human:** (none)
- **Out of this spec:**
  - TUI 人读合同（`specs/tui-human-display.md`）。
  - 改隔离开关默认、auto-provision、磁盘 task worktree 路径形状。
  - 把 **task worktree** 种类词从 CONTEXT 删掉（种类 ≠ 注册名）。
  - 加长 soul / usage 代替夹具。

## Success Criteria

- **SC1（注册名）**：`rg "create-task-worktree" src/` 模型面（工具 `name` / 门禁 hint / git-work 正文）零命中；`create-worktree` 在注册表。测试：`bun test tests/harness/aci/tools/` 与工作树生命周期套件。
- **SC2（说明书无政策）**：五件 `description` 不含 `worktree_isolation`、不含「list-task」/「先 list」。d9 / description 闸仍绿。
- **SC3（夹具·建树）**：隔离 ON、未绑树、输入要求创建工作树 → 首工具 `create-worktree`（与 #960 同形：固定输入 + 可判定首工具）。
- **SC4（夹具·列出）**：输入要求列出/有哪些工作树 → 首工具 `list-worktrees`。
- **SC5（回执点新名）**：unbound mutate 回执含 `create-worktree`，不含旧名。
- **SC6（回归）**：`npm test` 全绿。真模型夹具：`npm run test:real-llm` 有 key 则跑；缺 key → Not run，LLM 裁判不能单独放行。

## Open Questions

(none)

## Inherits / Changes

**Quotes（CONTEXT.md）：**

- **worktree tool description（工作树工具说明书）**: 注册名是 `create-worktree` / `enter-worktree` / `exit-worktree` / `list-worktrees` / `remove-worktree`。description 先服务 agent：能不能调、做什么。
- **worktree isolation mode**：门禁从不自动建树。
- **写处境**：告知面不点名建树工具；点名留在门禁回执。
- **说明书 vs 闸 vs 提示词** / **create-worktree vs create-task-worktree**。

**Inherits：** ADR-0037 / 0069 / 0070 / 0079 / **0082**；`CREATE_TASK_WORKTREE_TOOL_HINT` 一类 hint 改字节、语义仍是「点名胜」。黄金夹具跟测试放（#960 先例）。

**Changes：** 五件注册名；description 去政策；hint / git-work / TUI 表随名；新增建树/列出首工具夹具。

**待写入：** (空)

## architecture-change-reviewer

```
bounded-context-guardian: yes — 改 ACI 注册与 identity 纪律段、门禁 hint；不新开 context；TUI 只跟名。
defensive-contract-validator: yes — 夹具 empty/负（喊 list 不误 create）/ 已绑树幂等 / 并发两会话名不串 / 门禁失败 typed。
error-handling-enforcer: yes — 不改失败 kind 表；只改回执里的工具名。
complexity-anti-drift: yes — 机械改名 + 短 description；禁止把政策抄进第二份 system。
minimal-change-verifier: yes — 单一逻辑任务：工作树模型面改名与说明书分层（与 TUI 人读分票）。
```
