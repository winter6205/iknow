# Spec: task worktree 生命周期（命名 · 进树 · 发现 · 回收 · 进树后可读）

> 门禁语义沿用 ADR-0037：隔离开则主仓只读，写被拦，host 不自动建树；模型调 ACI 建树并 **session worktree rebind**。本 spec 只补闸后面的产品面：可读标签、一把可执行的进树动作、列出与显式删除、以及改绑后仍能读项目身份根。
>
> **Amended 2026-09-04** by `specs/casual-ask-context-hygiene.md`：门禁「什么算写」不再复用 `validateReadonlyCommand`；unbound 说明书改成事实阻断。条款 6 仍点名 `create-task-worktree`；条款 8 文案以 hygiene spec 为准。本文件仍管命名 / 进树 / list / remove，不改 ACI 工具形态。

## Objective

隔离 ON 时，模型被拦一次写之后，用 **一次** `create-task-worktree`（可选短名）建树并改绑，下一波把同一写打进该树。之后能列出本仓 task 树、按标签或 conversationId 进入已有树、显式删掉不再需要的树。新树不是空壳到无法读说明书：`grep` / `glob` 与 `read_file` 一样能读 `projectIdentityRoot`。叶子名兼职身份与展示的现状结束。

成功 = 带合法 `name` 建树后路径为 `<repoRoot>/.iknow/worktrees/<slug>`；非法 `name` 回落 UUID 叶子且 tool_result 写明实际路径；同名已存在 → typed `worktree_exists` 不覆盖；`list-task-worktrees` 给出 label + conversationId；`remove-task-worktree` 可审计删除；历史 `<slug>--<conversationId>` 与无 `--` 叶子仍可反演。

## Glossary

- **task worktree label**：给人/模型认树的 kebab 叶子名。有合法 label 时文件夹就是 `<slug>`，conversationId 不进目录名（gitdir sidecar + 历史 `--` 叶子仍反演身份）。非法或缺席则叶子仍是纯 conversationId。同名已存在则建树失败，不覆盖。
- **worktreeinclude**：项目身份根上的 `.iknow/worktreeinclude`，gitignore 语法；建树成功后只拷「匹配且已被 gitignore」的文件进新树。
- **worktree isolation mode** / **session worktree rebind** / **taskRoot** / **projectIdentityRoot**：沿用 CONTEXT。

_Avoid_: 用 session `title` / `goal` 推导 label；把 label 当 conversationId 做归属裁决；把 git worktree 当 serve 多根。

## Architectural Constraints

- **ADR-0037** 门禁、fail-closed、不自动 provision、改绑只切 `taskRoot`、batch 快照、exit 不自动删树、自动孤儿清理仍非目标：**不改**。§3 命名合同本 spec **reopen**：有合法 label 时叶子是 `<slug>`（conversationId 不进文件夹名）；反演优先 gitdir sidecar，并兼容历史 `--` 叶子与 UUID-only 叶子。同名 label 全仓唯一，撞名 fail-closed。
- **ADR-0004**：8 件基线不动。本能力全部落在既有 worktree 条件 ACI 家族（与 create / enter / exit 同一 host 缝、同一开关、不进 worker）。
- **ADR-0019 / 0023**：per-root 状态锚与 serve 单根不动。
- **ACI 名单**：只允许 `ACI_TOOLSET_NAMES` 末尾 append；Gate 3 与 factories 同步。

## Contract

### 命名

1. `taskWorktreePath(repoRoot, conversationId, label?)`：有合法 label 时叶子 `<slug>`，否则 `<conversationId>`。
2. `taskWorktreeOwnerOf(root)`：优先读 gitdir sidecar `iknow-conversation-id`；否则叶子含 `--` 则取最后一段 `--` 之后为 conversationId；否则整段叶子为 id。历史 `<slug>--<id>` 树无迁移。
3. 分支无反演器。有 label 时 `iknow/task/<slug>-<uuid8>`（uuid8 = id 前 8 位）；无 label 时保持 `iknow/task-<conversationId>`。uuid8 与已有分支撞名 → typed 可见错误，不覆盖、不加长。
4. 合法 slug：`SAFE_WORKTREE_SLUG_RE` = 全小写 kebab、首尾字母数字、禁止连续 `-`（从而禁止 `--`）、长度 2–40。不匹配则 **丢弃 label、走无前缀形状、不抛错**；tool_result 必须写出丢弃原因与实际 path。
5. 不变量：身份是 sidecar / 历史后缀 / UUID 叶子；label 除展示、enter 定位与目录名外不得冒充 conversationId 做归属裁决；同一 conversationId 仍至多一棵树（幂等）；同一 label 全仓至多一棵树（撞名 → `worktree_exists`）。

### 进树（闸的那一次）

6. 门禁 unbound mutate 的 hint **仍指向** `create-task-worktree`（与今日常量对齐）。
7. `create-task-worktree` 增加可选 `name`（string，maxLength 40）。省略或非法 → 条款 4。成功 = 树在且本会话已 rebind；同会话再调幂等，不第二次 `worktree add`。
8. 当波被拦的写仍不执行；下一波在新根重发。文案保持「再打一次写」，不要求 `/continue`。
9. 建树成功后，若身份根存在 `.iknow/worktreeinclude`，按条款「只拷匹配且 gitignored」拷进新树；文件缺席或空 = 不拷，不失败建树。

### 发现与进入已有树

10. `list-task-worktrees`：只读 ACI。实现以主 checkout 的 `git worktree list` 为主，用 `taskWorktreeOwnerOf` 过滤。每条至少 `{ label, conversationId, path, branch, head, dirty }`。可选 `include_stale`：无活树但存在对应 `iknow/task*` 分支的条目。不进 `ROOT_FLIP_TOOLS`。host 缝缺席则不注册。
11. `enter-task-worktree` 仍不收自由路径。入参为 conversationId **或** 与 list 相同的 label（本仓唯一匹配）。歧义（同 label 多棵）typed 失败，列出 conversationId。

### 回收

12. `remove-task-worktree`：入参与 enter 同形。fail-closed：脏树 / 有未推送独占提交 / 是调用者当前根（须先 exit）/ 非本仓。默认 `git worktree remove`，**不删分支**；`delete_branch: true` 且无独占未推送提交才删分支。ACI `category=write`。门禁分类不得标成 workspace `mutate`（否则主仓上无法回收），也不得进 `ROOT_FLIP_TOOLS`。
13. 操作员脚本默认 report-only，列出无活树且无独占提交的 `iknow/task*` 分支；`--apply` 才删。不进 ACI 名单。

### 进树后读身份根

14. 隔离 ON 且已改绑时，父会话对 `projectIdentityRoot` 的只读放行从「仅 `read_file`」扩到 `grep` 与 `glob`。写仍不得进主仓。worker 工具面本 spec 不扩（说明书仍灌入）。

## Out of Scope

- 改门禁何时拦、是否自动 provision、batch 快照、活 taskRoot writer。
- 自动删除孤儿树。
- 8 件基线新增 `list_dir` / 把 worktree 工具升基线。
- 从 `title` / `goal` 推导 slug。
- TUI chrome / slash / Session HTTP 专用 worktree API。
- 子代理独立一棵树（仍跟父会话，ADR-0040）。
- serve 产品多根。

## Commands / Success Criteria

```bash
npx vitest run tests/harness/isolation tests/harness/aci/tools/registry.test.ts tests/session-api/hub-worktree-isolation.test.ts
```

1. ON + `create-task-worktree` `{"name":"fix-648"}` → 叶子 `fix-648`，分支 `iknow/task/fix-648-<uuid8>`，会话改绑，下一波 mutate 进该树，主仓该写未落。
2. 同会话再 create → 同一棵树，无第二次 `worktree add`。
3. `name` 含 `--` / 大写 / 超长 → 不抛错，叶子为纯 uuid，tool_result 含实际 path。
4. 现存 `.iknow/worktrees/<uuid>` 与 `.iknow/worktrees/<slug>--<uuid>` 的 provision / enter / exit / 沙箱放行与今日逐字一致。
5. `list-task-worktrees` 在缝在场时列出全部本仓 task 树；OFF / worker 名单中无此名。
6. 带 label 的树上 `foreign_worktree` 仍 fail-closed（owner 反演往返）。
7. 另一会话再用同一 `name` → `worktree_exists`，不覆盖。
8. `enter` 用 list 返回的 label 进入唯一匹配树。
9. `remove` 拒绝当前根与脏树；干净树可删；gc 脚本无 `--apply` 时磁盘与分支不变。
10. 改绑后 `grep` / `glob` 能命中 `projectIdentityRoot` 上的项目文件；对该根的 write 仍拦。
