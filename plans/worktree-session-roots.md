# Plan: worktree session roots

**Goal:** isolation ON 且会话改绑到 task worktree 之后，项目身份与 per-root 状态仍读主仓当前份；树上只承担写与 git；iknow worker 能在无 `node_modules` 的裸树上启动。
**Approach:** 先把「按角色分根」写进合同（改绑只动 taskRoot；review 期间又从 `productRoot` 里分出第四根 `projectIdentityRoot`，见 T3），再把 MCP 已有双根升成会话级 SSOT，按角色分批把发现/落盘从 `cwd` 迁走，最后用真 `git worktree add` + 真 worker 钉住。不往每棵树拷 `.iknow`，不在同回合旧引擎上放行 mutate。
**Spec link:** none — 合同来自本文件「合同」段 + ADR-0037 / ADR-0019 / #828 MCP 双根；操作员选择跳过独立 spec、直接本计划。上游地图 [#829](https://github.com/winter6205/iknow/issues/829)。
**Tracker:** GitHub `ready-for-agent` 每 bullet 一票；本文件为切片 SSOT。
**Map:** https://github.com/winter6205/iknow/issues/829
**ACR:** PASS（2026-08-31，见下文）。
**Plan closeout (2026-09-01):** T1–T6 运行时代码已随 #861（`66469c0b`）进 master。T3 按 round-5 缩窄验收收口；三条 follow-up 仍未开工，不回写进 T1–T6。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch；整轮改动收尾再 code-review（非每票重复）。

> Contradicts ADR-0037 §4 — worth reopening because 原文把「本会话生效根锚」写成 `cwd` / `workspaceRoot` 一并切到 task worktree，导致 ADR-0019 的 per-root 状态锚与写隔离根撞在同一字段上。本计划拆成 `productRoot`（不动）与 `taskRoot`（跟树）；`workspaceRoot` 不再在改绑时兼当记忆/settings/说明书根。
> Contradicts ADR-0019 读法「session 改绑后 workspaceRoot 取值即状态锚」— worth reopening because isolation 只隔离 mutate 物理检出，不把项目记忆库、permissions、说明书迁到 gitignored 空树上。D1.1 默认解析与 serve 主根语义不改。

## 待写入（T1 落盘；本计划提交不刷 CONTEXT/ADR）

- 修订 ADR-0037 §4：改绑只切换 `taskRoot`（sandbox / git / bash cwd / 写工具 / LSP 目录 / 子代理工作目录）；`productRoot` 首次装配钉死、跨 rebind 与重启不变（重启可由 task 树的 git common dir 派生，与 exit 工具同源）。
- CONTEXT 增补 **taskRoot**、**installRoot**；扩展 **productRoot**：不止 MCP，还覆盖项目说明书 / AGENTS.md / permissions / 项目 skills 发现 / 记忆库 / tasks 登记 / settings 读与 watch。
- 对照：`mcpConfigRoot` 仍由 `productRoot` 派生（#828 保持）；禁止再为 rules/memory/permissions 各做一套双根。

## 合同（开关 ON，改绑成功后）

```text
productRoot  = 开会话时的主 checkout（不动）
taskRoot     = 本会话 task worktree（create/enter 切过去，exit 切回主仓）
installRoot  = iknow 运行时安装位置（worker 的 tsx / 自身依赖；≠ 用户项目 node_modules）

projectIdentityRoot = 用户此刻在做的那个项目（今日 = 启动 cwd），跨改绑不动
  与 productRoot 分开的原因：宿主按 ADR-0019 把 productRoot 取自 workspaceRoot，
  而 `--workspace-root <dir>` 重定向档下 <dir> 不是项目（dir ≠ cwd）——
  拿它查身份会让项目自己的 AGENTS.md / rules / skills 静默消失（review round 2 实测）。

项目身份        →  只问 projectIdentityRoot（宿主启动时钉一次；缺席退 mainCheckoutOf(cwd)）
  rules / 项目 AGENTS.md / permissions.toml / 项目 skills / 子代理继承的身份根
  记忆库命名空间名（<basename>-<sha1>）

per-root 状态   →  锚 workspaceRoot，仅当它自身已是 task worktree 时退 productRoot
  记忆库落盘根 / tasks 登记（--workspace-root 重定向由此保持生效）
  settings 读 / watch / 写回锚在启动时解析的根，改绑不重载

mcp.json        →  只问 productRoot（mcpConfigRoot 由它派生，已落地，行为不变）

写与工具 cwd     →  只问 taskRoot
  write_file / edit_file / 会改工作区的 bash / git / LSP / 子代理 cwd

worker 进程 bootstrap → 只问 installRoot
  不在 taskRoot 上解析 iknow 自己的 node_modules
```

**硬要求**

1. 改绑成功不复制、不 seed 主仓 `.iknow/{rules,skills,memory,sessions,tasks}` 到树上；树上缺目录视为空，项目身份仍读身份根（`projectIdentityRoot`，见 T3 review note）上的现有文件。
2. 调用方禁止 `join(cwd, '.iknow', …)` 或 `join(workspaceRoot, '.iknow', …)` 充当项目身份；一律经会话根 SSOT 按角色取路径。新消费者漏接必须在装配/类型层可见失败，不能拖到 TUI 实跑。
3. 同回合旧引擎（仍扎在改绑前根）对 mutate 继续拦；Host 不同波重放；模型下一回合在新 `taskRoot` 上自己再写（ADR-0037 amendment 已有，本计划不改）。
4. 用户级 `~/.iknow`（画像、用户 rules/AGENTS、init.sh、trust）继续跟 `home`，不跟 `productRoot` 也不跟 `taskRoot`。
5. 开关默认 OFF；OFF 与今日一致。
6. 裸 task worktree（无项目 `node_modules`、无 `.iknow`）上真 worker 进程不得 `[subagent-worker] fatal` / `scandir` ENOENT / `Cannot find package`（iknow 自身依赖）。
7. 用户项目在树上跑 `npm test` 仍可能缺依赖——那是 git worktree 语义，本计划不自动 symlink、不关 isolation 混过去。
8. 不采纳同引擎 `setReboundRoot` 放行 mutate；不把 seed 空目录当主修法。

**明确非本计划**

- commit → push → PR 产品向导
- 默认把开关改成 ON
- product workspace 多根 / serve 主根重绑
- 孤儿 worktree 自动删除
- 给每棵 task 树 `npm install` 或共享用户项目 `node_modules`
- MCP 双根行为变更（只并入同一 SSOT，读路径仍是 `productRoot/.iknow/mcp.json`）

**本计划留下的 follow-up（未开工，记在此处以免 review note 空指）**

- **把 `loadProjectSettings` 接进生产权限装配**：`createPermissionPolicy` 目前只收 `session` / `mode`，从不收 `project`，所以 `.iknow/permissions.toml` 整条规则源在生产里不生效（本计划只保证它的**路径**锚在 `productRoot`，见 T3 review note）。接线会让一套此前不生效的规则开始改变权限判定，属行为变更，需自带值域 / 冲突优先级与 fail-closed 用例。
- **`grep` / `glob` 的主仓只读放行**：改绑后二者仍限在 `taskRoot`，与 ADR-0037 §1「读路径可留在主仓」不齐（§4 已如实记为已知缺口）。只有 `read_file` 拿到了身份根放行，且只在隔离开 + 已改绑时开。
- **worker 侧身份根仍有 cwd 回退**：`src/harness/subagent/worker.ts` 的 `opts.projectIdentityRoot ?? cwd` 与 ADR-0037 §4「不回退 `process.cwd()`」不齐（review round 4 记录）。实践中被父侧无条件透传遮住，但 worker 单独起时无 typed fail-closed。属既有代码，不在本计划面内 —— 下次动 worker 入口时收敛。

## ACR

```
bounded-context-guardian: yes — 会话根 SSOT 落在现有 isolation/workspace 能力（升 MCP 双根，不新开 controllers/services）；说明书仍 memory；权限仍 permission；落盘仍 session-api / config；写隔离仍 gate。不按技术层拆目录。
defensive-contract-validator: yes — 空（裸 worktree 无 .iknow）、否定（未改绑仍拦写；productRoot 空路径 fail-closed）、溢出（同名树既有 typed）、并发（同会话建树幂等既有）、异常（git/改绑失败 typed、主仓零写入）均有硬要求与对应 bullet。
error-handling-enforcer: yes — 根缺失/相对路径走既有 typed 根错误，不回退 process.cwd()；缺目录跳过不是 throw；禁止空 catch 放行写主仓。
complexity-anti-drift: yes — 一个解析器按角色出根；migrate 按身份/状态/worker 分批；不在每个消费者里复制 if-worktree 分支。
minimal-change-verifier: yes — 决策 → expand SSOT → 两批 migrate → worker → E2E；seed 目录与 same-turn mutator 列为非目标。
OVERALL: yes
```

## Tasks (ordered by dependency)

1. **Record session-root split (product / task / install)** ([T1](https://github.com/winter6205/iknow/issues/855)) — tag: `[decision]`
   - **Inherits:** 上文合同与硬要求 1–8；ADR-0037 改绑不得静默重载 settings；#828 `mcpConfigRoot` ← `productRoot`
   - **Surface:** `docs/adr/` + `docs/CONTEXT.md`
   - **Acceptance:** ADR-0037 §4 写明只切 `taskRoot`；CONTEXT 有 `taskRoot` / `installRoot` 及扩展后的 `productRoot`；本 bullet 不含运行时代码
   - Status: [x] done（ADR-0037 §4 重写 + CONTEXT 四个根词条）

2. **Expand session-root SSOT beside MCP dual-root** ([T2](https://github.com/winter6205/iknow/issues/856)) — tag: `[implementation]`
   - **Inherits:** 硬要求 2；MCP 读路径字节不变；缺根 / 相对路径 fail-closed 不回退 `process.cwd()`（与现有 MCP roots 同纪律）
   - **Surface:** harness isolation 或现有 MCP roots 所属上下文（升格为会话根，MCP 改为消费者）
   - **Acceptance:** 同一输入可问出 `productRoot` / `taskRoot` / `installRoot`；`mcpConfigRoot` 仍等于 `productRoot`；旧 MCP 调用方行为不变
   - Status: [x] done（`src/harness/session-roots.ts`；MCP roots 降为消费者）
   - [blocks: T1]

3. **[parallel] Project identity follows projectIdentityRoot** ([T3](https://github.com/winter6205/iknow/issues/857)) — tag: `[implementation]`
   - **Inherits:** 硬要求 1、4；说明书读法（缺目录视为空）；干活子代理注入的是 **productRoot 上已存在** 的 AGENTS.md 与 rules，不是树上的空拷贝
   - **Surface:** harness memory discovery/assembly、skill scanner、permission 项目源、工具 sandbox 读放行
   - **Acceptance:** 改绑后装配与 general-purpose 注入仍读主仓当前 `.iknow/rules`、项目 `AGENTS.md`、`.iknow/permissions.toml`、项目 skills；sandbox 在**隔离开且已改绑**时允许只读这些 `projectIdentityRoot` 路径（开关 OFF 或未改绑都不放行 —— 硬要求 5，这条放行是本分支新增的，今日为零），写仍不得进主仓；树上不出现新拷的 rules 目录
   - **Acceptance 缩窄（review round 5）：** 只读放行只覆盖 `read_file`。`grep` / `glob` 改绑后仍限在 `taskRoot`，本计划**不**扩它们（见下方 follow-up）—— 上面那句「允许只读这些路径」按工具逐个读，不是整个读工具面。
   - Status: [x] accepted-with-follow-up（2026-09-01）—— 计划面内验收按 review round 5：rules / `AGENTS.md` / 项目 skills 已绿（`tests/harness/identity-follows-identity-root.test.ts` 本工作树复跑 9 passed）；`permissions.toml` 路径解析已钉、生产接线与 `grep`/`glob` 主仓只读放行列入下文 follow-up，不挡本计划收口。issue #857 可关。
   - Review note（`permissions.toml` 半边）：路径解析已钉在 `<projectIdentityRoot>/.iknow/permissions.toml` 且缺根 / 相对根 fail-closed（`tests/harness/permission/project-settings.test.ts`「project settings path resolution」组），但**端到端仍是 N/A-with-reason**：`loadProjectSettings` 目前没有生产调用方（全仓只有测试引用），把它接进 `createPermissionPolicy` 会激活一套此前不生效的项目权限规则 —— 那是行为变更，不在本计划面内，已记入下方「本计划留下的 follow-up」（尚未开 issue）。
   - [blocks: T2]

4. **[parallel] Per-root state stays on productRoot** ([T4](https://github.com/winter6205/iknow/issues/858)) — tag: `[implementation]`
   - **Inherits:** ADR-0019 记忆/tasks/settings 写回是项目状态不是 git 工作区；ADR-0037 改绑不隐式重载 settings 对象
   - **Surface:** harness memory 路径、background tasks 路径、config settings 读/watch/persist fallback
   - **Acceptance:** 改绑后记忆库目录、tasks 登记、settings 文件仍落在 `productRoot/.iknow/...`（与改绑前同一路径）；不在 task 树下新建另一份 memory/tasks/settings；启动注入的 settings 对象不因 cwd 换成树而重读空文件
   - Review note（High-1 收敛）：状态锚不是无条件 `productRoot`，而是「`workspaceRoot`，仅当它自身已是 task worktree 时退到 `productRoot`」，且记忆库**命名空间名**改由宿主启动时钉下的 `projectIdentityRoot` 决定（可能是仓内子目录，见 T3 review note） —— 否则 ADR-0019 D1.3 的 `--workspace-root <dir>` 重定向档下同锚多项目会塌进同一命名空间、老命名空间目录变不可达。守门：`tests/harness/state-roots-namespace.test.ts`（含 `cwd ≠ workspaceRoot` 档）
   - Status: [x] done（`tests/harness/state-follows-product-root.test.ts`）
   - [blocks: T2]
   - [parallel]

5. **[parallel] Worker bootstrap uses installRoot** ([T5](https://github.com/winter6205/iknow/issues/859)) — tag: `[implementation]`
   - **Inherits:** 硬要求 6、7；T5 子代理 cwd 仍是父会话 `taskRoot`（工作目录跟树，解析 iknow 自身依赖不跟树）
   - **Surface:** harness subagent spawn / worker 入口
   - **Acceptance:** 在无 `node_modules`、无 `.iknow` 的目录上以该目录为 cwd spawn 真 `__subagent_worker__`，stderr 无 `[subagent-worker] fatal`、无 `scandir` ENOENT、无 `Cannot find package`（iknow/tsx）；不要求操作员 symlink
   - Status: [x] done（`tests/subagent/worker-bootstrap-install-root.test.ts`：真 worker 跑在裸目录上）
   - [blocks: T1]
   - [parallel]

6. **Naked worktree E2E: identity from main, worker lives, writes stay on the tree** ([T6](https://github.com/winter6205/iknow/issues/860)) — tag: `[implementation]`
   - **Inherits:** 硬要求 1、3、6；create-task-worktree 成功后下一回合 mutate 进 task 树、主仓零写入（既有 hub 合同）
   - **Surface:** session-api isolation 与 subagent 的现有集成面（真 git，不 mock provision）
   - **Acceptance:** 真 `git worktree add` 后不 mkdir `.iknow`、不链 `node_modules`：仍读到主仓 rules/permissions/记忆路径；真 worker 不 fatal；一次 mutate 只落在树上；同回合旧根 mutate 仍被拦。CI 若仍排除 bwrap 组，本验收在本地 WSL 必跑，不得只靠 GHA 绿灯
   - Status: [x] done（`tests/session-api/naked-worktree-e2e.test.ts`：真 git worktree add + 真 worker，本地 WSL 实跑）
   - [blocks: T3, T4, T5]
