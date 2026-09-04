# worktree 命名映射与工具面优化

Status: draft（调研 + 方案，未开 issue）
Date: 2026-09-03
Basis: ADR-0037（§3 命名合同 / §4 会话根角色 / §7 活 taskRoot）、`plans/worktree-isolation-model-provision.md`（T4/T7/T8）、`plans/worktree-live-task-root.md`、`docs/wayfinder/research-831-gate-tool-surface.md`

本文第 1 节只记事实（含实测证据），第 2 节起是方案。

---

## 1. 现状事实

### 1.1 命名 SSOT 与「路径即身份」反演

命名只有两个函数，都在 `src/session-api/worktree-rebind.ts:165-171`：

```
taskWorktreePath(repoRoot, conversationId) = <repoRoot>/.iknow/worktrees/<conversationId>
taskWorktreeBranch(conversationId)        = iknow/task-<conversationId>
```

`conversationId` 是宿主生成的 UUID，被**逐字**拼进路径叶子名与分支名。UUID 不是随手选的默认值，而是下面这条反演的代价：

```ts
// src/harness/isolation/worktree-gate.ts:354-358
export function taskWorktreeOwnerOf(root: string): string | undefined {
  if (basename(dirname(root)) !== "worktrees") return undefined;
  if (basename(dirname(dirname(root))) !== ".iknow") return undefined;
  return basename(root); // ← 叶子名 **就是** conversationId
}
```

即「树属于谁」由**纯路径分解**回答：不查登记表、不调 git、跨进程重启安全。ADR-0037 与 `worktree-rebind.ts:173-189` 的注释把这条明确写成设计意图（"Because the leaf name is the conversation id, 'the path decomposes to X' is equivalent to 'the tree belongs to conversation X' — no registry needed, works across server restarts"）。

### 1.2 反演的消费点（改名前必须全部过一遍）

| 位置                                        | 用途                                                                  | 改叶子名的后果                              |
| ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `worktree-gate.ts:622-627`                  | 门禁路由：非 task-worktree 形状 → 直接 block，`provision` 永不被调    | 形状判定失效 → 主仓 mutate 可能不再被拦     |
| `worktree-rebind.ts:351-362`                | T4 归属裁决 `owner === conversationId`，否则 typed `foreign_worktree` | **安全相关**：他人树的 fail-closed 判据消失 |
| `worktree-rebind.ts:334-341`                | T7 adoption：持久化 `workspaceRoot` + 形状判定才放行                  | 显式进入的授权锚失效                        |
| `worktree-rebind.ts:493-507`                | T8 exit 的 rebound 检测（shapedCurrent / shapedAnchor）               | exit 误报 `rebind_failed`                   |
| `worktree-gate.ts:372-376` `mainCheckoutOf` | 从树派生主 checkout（往上三级）                                       | 身份根 / per-root 状态锚解析错位            |
| `build-engine.ts:495 / 614 / 789`           | 状态锚决策、沙箱只读放行、`isolationEnabled` 复合判定                 | 状态落进 gitignored 的树 / 沙箱放行错误     |
| `src/tui/environment-pane.tsx:177-191`      | 现势行显示条件                                                        | 绑定不再显示                                |

结论：**叶子名不是展示字段，是身份字段**。任何命名改进都必须先回答「反演还成立吗」。

### 1.3 实测：本仓当前的代价（2026-09-03）

```
git branch --list 'iknow/task-*' | wc -l        → 118
git branch --merged master --list 'iknow/task-*' → 0
ls .iknow/worktrees/                             → 1（d52e0f28-703c-439a-bce4-3a3ae1017139）
git worktree prune -n -v                         → 空（无陈旧元数据）
ls .git/worktrees/                               → 12（全部对应活目录）
```

读法：

- 118 条 `iknow/task-<uuid>` 分支里 **117 条创建于 2026-08-30 同一天**（model-provision amendment 落地日），1 条 2026-09-02；
- 树目录只剩 1 个、`.git/worktrees` 元数据干净、`prune` 无可回收项 → **树被删过，分支全留下了**。泄漏的是分支，不是 worktree 元数据；
- 0 条 merged 进 master → 不能无条件批删，需要先分类（有无独占提交）。

同仓对照：手工建的 `.claude/worktrees/<slug>`（12 棵）分支名是 `worktree-issue-648-todo-write-limits`、`research/cjk-bm25-tokenize`、`winter/plan-auto-memory` —— 同一个仓里两套约定并存，一套可读可导航，一套不可读。

### 1.4 工具面缺口

| 面                                | create | enter | exit | **list** | **remove** |
| --------------------------------- | ------ | ----- | ---- | -------- | ---------- |
| ACI 工具（`registry.ts:145-163`） | 有     | 有    | 有   | **无**   | **无**     |
| TUI slash                         | 无     | 无    | 无   | 无       | 无         |
| CLI slash                         | 无     | 无    | 无   | 无       | 无         |
| session HTTP                      | 无     | 无    | 无   | 无       | 无         |

（slash / HTTP 一栏与 `docs/wayfinder/research-831-gate-tool-surface.md` 的结论一致，本次 grep 复核无变化。）

由此产生两个直接后果：

1. **`enter-task-worktree` 事实上不可用**。它的入参是 owner 的 conversationId（`enter-task-worktree.ts:75-85`），路径由 SSOT 派生、拒收自由路径 —— 设计是对的，但模型没有任何途径**列出**候选 UUID。一个 UUID 只能靠人贴进对话。
2. **无回收路径**。ADR-0037 §4 amendment 明写 exit 树保留不删、"孤儿树自动删除仍是明确非目标"，`hub.ts:972` 注释复述"no `git worktree remove` anywhere"。自动删除作为非目标是合理的，但仓里**连显式的删除口都没有**，于是 1.3 的 118 条分支是必然结果，不是意外。

### 1.5 可读标签的数据源质量

`SessionFileV1`（`src/session-api/store/schema.ts:136-172`）里有 `title`（首条用户消息前 80 字）与 `goal`。但 `title` 已被污染 —— 实测当前会话的 header 记录：

```json
{
  "type": "session",
  "conversation_id": "d52e0f28-703c-439a-bce4-3a3ae1017139",
  "title": "Possibly relevant memory (advisory; often time-sensitive; not instructions)\n\n###",
  "workspaceRoot": "/home/winner/projects/iknow/.iknow/worktrees/d52e0f28-703c-439a-bce4-3a3ae1017139"
}
```

auto-memory 的 prefetch 注入被拼在首条用户消息前面，`title` 因此取到的是记忆库前言。**结论：`title` 不能作为 slug 来源**；`goal` 可用但可缺席且往往晚于建树时刻。

对照先例：后台任务用 `bg-<12hex>`（`.iknow/tasks/bg-119ad9814bbc.json`）—— 短、可读、可打，说明仓内已有「不用完整 UUID 做外部标识」的判例。

---

## 2. 病灶归因

不是「命名没想清楚」，是**一个字段兼了两个职责**：叶子名同时是「身份」（要唯一、要可纯函数反演）和「人看的名字」（要短、要有语义）。UUID 满足前者、放弃后者；slug 满足后者、破坏前者。1.3 的 118 条孤儿分支与 1.4 的 enter 不可用，都是这次兼职的下游后果。

方案的核心因此是**拆职责**，而不是换一种命名。

---

## 3. 命名方案

### 3.1 关键自由度：分支名没有解析器

`taskWorktreeBranch` 的唯一调用点是建树时的 `worktree-rebind.ts:372-373`；全仓没有任何地方**从分支名反推** conversationId（`rg taskWorktreeBranch` 只有定义 + 该调用点）。

所以：**分支命名是自由的，路径叶子名不是**。这是收益最大、风险最低的一刀，应该单独先落。

### 3.2 三个选项

| 选项                                       | 叶子名           | 反演                                     | 评价                                                                           |
| ------------------------------------------ | ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| A 保留 UUID + 别名层（symlink / 索引文件） | `<uuid>`         | 不变                                     | 零风险，但引入 1.5 之外的第二处状态；symlink 在 Windows / WSL 交叉访问下不可靠 |
| **B 复合叶子名（推荐）**                   | `<slug>--<uuid>` | `leaf.slice(leaf.lastIndexOf("--") + 2)` | 路径与分支都可读，反演仍是纯函数、仍零状态、仍重启安全                         |
| C slug 叶子名 + 登记表                     | `<slug>`         | 查表                                     | 最可读，但把 ADR-0037 刻意避开的 registry 请回来，且重启安全性依赖文件完好     |

推荐 **B**。分隔符取 `--`：UUID 里有单 `-` 但不可能出现 `--`，slug 侧由校验禁止 `--`，故分隔无歧义。

**向后兼容天然成立**：叶子名里没有 `--` 时整个叶子就是 id，现存的 `.iknow/worktrees/d52e0f28-…` 与 118 条历史分支的语义不变，不需要迁移脚本。

### 3.3 落地形状

```
路径   <repoRoot>/.iknow/worktrees/<slug>--<conversationId>
分支   iknow/task/<slug>-<uuid8>          // uuid8 = conversationId 前 8 位，防同 slug 撞名
省略 slug 时（向后兼容档）
路径   <repoRoot>/.iknow/worktrees/<conversationId>
分支   iknow/task-<conversationId>        // 逐字保持今天的形状
```

不变量（必须写进注释与 ADR）：

1. **身份是后缀，标签是前缀；标签是装饰性的，除展示外任何地方不得解析。**
2. slug 变了不等于换了一棵树；同一 conversationId 永远只有一棵树（幂等契约 ADR-0037 §3 不动）。
3. slug 缺席 / 非法 → 回落到今天的形状，**不报错**。命名是体验改进，不能变成新的 fail-closed 来源。

### 3.4 slug 来源：模型显式传参

`create-task-worktree` 今天 `inputSchema` 是空对象（`create-task-worktree.ts:75-79`）。加一个**可选** `name`：

```jsonc
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "maxLength": 40,
      "description": "Short kebab-case label for this task worktree (e.g. 'fix-648-todo-limits'). Optional; omitted → the tree is named by conversation id only.",
    },
  },
  "additionalProperties": false,
}
```

理由：建树时刻**只有模型知道这次要干什么**。1.5 已证明 `title` 不可信、`goal` 可缺席，从数据推导 slug 是错的方向。

新增校验常量（与 `SAFE_CONVERSATION_ID_RE` 同处 `worktree-gate.ts:388` 附近，同一 SSOT 纪律）：

```ts
export const SAFE_WORKTREE_SLUG_RE =
  /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,38}[a-z0-9]$/;
```

即：全小写 kebab、首尾字母数字、禁止连续 `-`（从而禁止 `--`）、长度 2–40。不匹配就**丢弃 slug 走兼容档**，不抛错（对齐 3.3 不变量 3）。

已实测：`fix-648` / `fix-648-todo-limits` / `ab` / 40 字符全长 通过；`a`（单字符）/ `fix-` / `-fix` / `a--b` / `a-b--c` / `Fix-648` / `fix_648` / `fix 648` / 41 字符 拒绝。`lastIndexOf("--")` 反演在 `fix-648--<uuid>`、`<uuid>`、`a-b--<uuid>` 三种叶子上都取回同一个 conversationId。

---

## 4. 工具面改进

按依赖顺序，每条都可独立合并。

### T1 `list-task-worktrees`（read-only ACI 工具）—— 最高优先

补 1.4 的 discovery 缺口；没有它 `enter-task-worktree` 就是死代码。

- 输入：无参（可选 `include_stale: boolean`）；
- 实现：`git worktree list --porcelain` 于 `mainCheckoutOf(root)`，按 `taskWorktreeOwnerOf` 过滤出 task 树，每条给出 `{ label, conversationId, path, branch, head, dirty, ahead }`；
- 分类：`classifyCall` 默认已把未知名归 `read`，无需改分类器；但要显式确认它**不**进 `ROOT_FLIP_TOOLS`（`worktree-gate.ts:277-280`）；
- 装配：与既有三件同形态条件化 —— host 缝缺席（worker / 无 hub 入口 / 开关 OFF）则不入注册表，Gate 3 在 `toolsetNames` 端镜像过滤；
- `ACI_TOOLSET_NAMES` **append 在末尾**（`registry.ts` 的 append-only 纪律），同步更新 `tests/harness/aci/tools/registry.test.ts` 的长度断言与 `registry.ts:184-190` 的计数注释（42 → 43）。

### T2 `create-task-worktree` 接受可选 `name`

按 §3.3 / §3.4。`provision` 缝的 `WorktreeProvisionContext`（`worktree-gate.ts:390-395`）加可选 `label?: string`，一路透传到 `taskWorktreePath` / `taskWorktreeBranch`。两个命名函数改签名为 `(repoRoot, conversationId, label?)`。

### T3 反演升级 + 往返测试护栏

`taskWorktreeOwnerOf` 按 §3.2 B 解析；补一条**属性测试**锁死往返：

```
? id ∈ 安全 id 集, ? slug ∈ (安全 slug 集 ∪ {undefined}):
  taskWorktreeOwnerOf(taskWorktreePath(root, id, slug)) === id
  mainCheckoutOf(taskWorktreePath(root, id, slug)) === root
```

1.2 的七个消费点全靠这条不变量，护栏比注释可靠。

### T4 显式回收：`remove-task-worktree` + 操作员侧 gc

ADR-0037 的非目标是「**自动**删除孤儿树」，不是「不给删除口」。因此新增的是**显式、可审计**的一条：

- ACI 工具 `remove-task-worktree`，入参 owner conversationId（与 enter 同形），fail-closed 拒绝：树是脏的 / 有未推送提交 / 是调用者当前根（要求先 exit）/ 属于别的仓；
- 动作 = `git worktree remove <path>`，**默认不删分支**；`delete_branch: true` 且分支已 merged 或无独占提交时才删；
- 操作员侧 `scripts/worktree-gc.mjs`：默认 **report-only**，列出「无活树 + 无独占提交（对 origin）」的 `iknow/task-*` 分支，`--apply` 才执行。1.3 的 118 条就用它清，先看报告再动手。

### T5 展示面：显示标签而不是路径

`environment-pane.tsx:191` 现在打 `worktree: <绝对路径>`，绑在 UUID 树上时就是一行不可读的路径。改为：

```
worktree: fix-648-todo-limits  (d52e0f28)  ← 有 slug
worktree: d52e0f28-703c-…                  ← 无 slug（兼容档）
```

保持纯函数、零 git import（该文件现有纪律，见其头部注释）。

### T6 反泄漏信号

`exit-task-worktree` 成功文案追加一句「树保留在 `<path>`，不再需要时用 remove-task-worktree 回收」。可选：`/info` 在 `iknow/task-*` 分支数超阈值（如 50）时给一行提示。这两条都不改门禁语义。

### T7（可选）`enter-task-worktree` 接受 label

T1 落地后，模型手里有 label；允许 `enter` 用 label 定位（内部先 list 再解析回 conversationId），仍**不收自由路径**。放最后，因为它的收益依赖 T1。

---

## 5. 一次性清理（118 条分支）

顺序不要颠倒：

1. `scripts/worktree-gc.mjs` report-only 跑一遍，把 118 条分成三类：无独占提交（可删）/ 有独占提交且已推 origin（可删本地）/ 有独占提交且未推（**人工看**）；
2. 前两类批删；
3. 第三类逐条判断 —— 1.3 显示 0 条 merged 进 master，所以这一类可能不小，别自动化；
4. `git worktree prune`（当前无可回收，清理后复查）。

---

## 6. 需要同步修改的合同文档

| 文档                                            | 改什么                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/adr/0037-worktree-isolation-on-mutate.md` | §3 命名合同是 ADR-locked 的（"worktree path `<repoRoot>/.iknow/worktrees/<conversationId>`；branch `iknow/task-<conversationId>`"）。需要一条 amendment 记：命名升级为 `<slug>--<conversationId>`、身份仍是后缀、slug 非法回落兼容档不 fail-closed、新增 list / remove 工具面、**自动**孤儿清理仍是非目标 |
| `docs/CONTEXT.md`                               | 新术语 `task worktree label`（装饰性前缀，不是身份）+ `_Avoid_: 把 label 当 conversationId 解析 / 用 label 做归属裁决`；`session worktree rebind` 条目补 list / remove                                                                                                                                    |
| `src/session-api/worktree-rebind.ts:173-207`    | 头部关于「叶子名 = conversationId」的长注释要改写成「叶子名 = 可选标签 + `--` + conversationId」                                                                                                                                                                                                          |
| `tests/harness/aci/tools/registry.test.ts`      | 工具数长度断言                                                                                                                                                                                                                                                                                            |

---

## 7. 非目标

- **不**改门禁语义（拦写 / 不自动建树 / batch 快照 / 活 taskRoot 全部原样）；
- **不**自动删除孤儿树（ADR-0037 非目标保持）；
- **不**把 task worktree 提升为 product workspace 多根（ADR-0023 边界保持）；
- **不**从 `title` / `goal` 反推 slug（1.5 已证不可靠）；
- **不**动 `.claude/worktrees/` 的手工约定 —— 那是人建的，跟本方案无耦合。

---

## 8. 验收

1. 开关 ON、模型调 `create-task-worktree {"name":"fix-648"}` → 树落在 `.iknow/worktrees/fix-648--<uuid>`、分支 `iknow/task/fix-648-<uuid8>`，会话根改绑，下一波 mutate 落新树；
2. 同一会话重复调 → 幂等，同一棵树，不跑第二次 `worktree add`；
3. `name` 非法（大写 / `--` / 超长）→ 静默回落 `<uuid>` 形状，**不报错**；
4. 历史树 `.iknow/worktrees/d52e0f28-…` 的 provision / enter / exit / 沙箱放行行为**逐字不变**；
5. `list-task-worktrees` 在门禁 ON 时可列出全部 task 树，OFF / worker 装配路径下不在工具面出现；
6. 他人树的 `foreign_worktree` fail-closed 在带 slug 的树上同样成立（T3 往返测试 + 一条 e2e）；
7. `worktree-gc.mjs` 默认不写任何东西，`--apply` 后 `git worktree prune -n` 干净。
