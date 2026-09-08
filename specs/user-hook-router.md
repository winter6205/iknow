# Spec: 用户钩子同进程 router（内置/用户钩子）

> 来源：operator 授权自判假设闸（「差不多行了，你自己判断」）+ 本会话 logicsync（A 声明式 deny-only；V1 三事件；同进程 router 非 OS server；H1 目录为第二源且本 spec 不装载；builtin 不进 `settings.hooks`；产品开关正交）。
> 状态：SPECIFY。不 supersede `specs/126-hook-system.md`（引擎内 Pre/Post 契约仍有效）或 `specs/406-secret-roundtrip-mask.md`（默认密钥路径仍是 roundtrip）。

## Glossary（exact copy from docs/CONTEXT.md）

落盘后以 ADR-0055 与下列词条为准；起草时与 CONTEXT 已有条对齐：

- **双重承载面 (hook dual surfaces)**: (#126 决议 D1) 钩子系统的正式形态——引擎内承载面（Pre/PostToolUse，挂 permission-executor 5 步链，工具级/同步/无状态）+ 引擎外承载面（Stop，host/orchestrator 层订阅 `run()` completed 返回，任务级/多轮/有策略状态，实现即 #128 外挂自检层）。Stop 钩子的触发事件是 host 侧观察到的 `run()` 返回，不是引擎 Transition。
- **hook failure semantics (fail-closed / fire-and-forget)**: (#126 决议 D3) 引擎内钩子的异常语义分裂——Pre 钩子抛异常 fail-closed（该调用判 `execution_failed` + `hook_error` 前缀回灌模型，loop 不炸）；Post 钩子抛异常 fire-and-forget（只记录、不影响结果，观测层不反噬执行层）。钩子必须同步纯函数、禁慢 IO；慢验证归 Stop 承载面。
- **secrets guard**: (#126 决议 D6) Pre 缝第一个真实产品消费者——密钥模式拦截钩子，拦「工具调用参数内容夹带密钥/凭据」，与 hard-wall（命令形态 + 敏感路径）互补不重叠；模式来源双层：代码内置默认集 + 项目 settings 覆盖/追加，接入 `createAciExecutor` 产品路径。
- **project stack defaults (SSOT boundary) — settings 单承载收敛 (ADR-0015)**: LLM 配置收敛到 `~/.iknow/settings.json`（user）+ `<cwd>/.iknow/settings.json`（project 覆盖 user）单承载。

本 spec **待写入**（persist 刷进 CONTEXT，不在此发明定义）：`hook router`、`内置钩子（builtin hooks）`、`用户钩子（user hooks）`、`PreWrite (user hook event)`、`PreCommit (user hook event)`。

## Objective

把引擎内 Pre 缝从「单槽手写 + v0 `createNoOpHooks`」收成 **同进程 hook router**：组合 **内置钩子**（harness 必装配的拦截/观测，代码挂上）与 **用户钩子**（声明式 deny-only，`settings.hooks` 默认关）。用户是配了 `settings.json` 的操作员；成功 = 能用三条事件名拦住工具调用，且关用户钩子不会关掉自动记忆等已有产品开关。

## Boundaries

- **Does:**
  - 新能力模块 `src/harness/hooks/`：工厂返回挂上 permission 第 1 步（及组合既有 Post）的纯函数；形态对齐 ADR-0045「同进程 router」，不 fork、不起 daemon、不走 Unix socket。
  - 用户钩子（user hooks）V1：`settings.hooks.enabled` 缺席=关；`rules[]` 声明 `id` + `event` + 可选 matcher + `reason`。事件仅 `PreToolUse` / `PreWrite` / `PreCommit`。
  - PreWrite 复用 `classifyCall`（mutate SSOT），不自造「会不会写」。
  - PreCommit 只认工具调用形态为 `git commit`（含 `git -C <path> commit` 等：第一个非 option 子命令为 `commit`）；不认 `git status` / `git commit --help` / `git commit-tree`；**不是** session JSONL `createChatSessionCommitHook`。
  - Multiplexer：builtin 与 user 可叠；先拦先赢；坏正则构造期剔除 + `onHookError`，不毒化全工具面。
  - `hooks.enabled === false`（或缺席）不调用 user rules；内置钩子（builtin hooks）仍按各自原开关装配。
  - permission bypass 仍跑 user deny（与 hard-wall 同层：钩子不是 PermissionMode）。
  - 子代理引擎经同一 `buildHarnessEngine` / 同一份 merged settings 装配 user rules，无第二套后门。
  - 留下 `HookContribution` 形状，供后续文件源接入；本 spec **不**扫描 `~/.iknow/hooks/`。
- **Confirms with human:** （本轮已自判关闭）无。
- **Out of this spec:**
  - 装载 `~/.iknow/hooks/` / 项目 `.iknow/hooks/`（H1 第二刀）。
  - JS/TS 用户模块、外壳 command hook、Post/Stop/PreCompact/SessionStart 用户事件。
  - PrePush、把 isolation / hard-wall / secrets roundtrip 吞进单一 Policy server。
  - TUI/Web 钩子面板（V1 只 settings 文件）。
  - 改 `settings.memory` / `/memory`、`settings.secrets`、graph、isolation、verify 的语义或默认值。
  - 把 `memory/auto-hook.ts` 迁进 hook router。
  - 5 步链加步、改 `ToolExecutionResult` 变体、StopReason。

## Success Criteria

1. `hooks.enabled` 缺席或 `false`：user `rules` 即使写了也不产生 `[hook_blocked]`；`npx vitest run` 覆盖该属性的测试退出 0。
2. `enabled: true` + `event: PreToolUse` 且 matcher 命中：该调用 `execution_failed`（或既有 deny 包装）且 message 含 `[hook_blocked]` 与规则 `reason`；未命中放行进入既有 permission 链。定向测试退出 0。
3. `event: PreWrite`：`classifyCall` 为 mutate 的调用可被拦；只读调用（如 `read_file`）即使规则极宽也不因 PreWrite 被拦。定向测试退出 0。
4. `event: PreCommit`：argv/子命令判定为 `git commit` 的 bash（或等价）可被拦；`git status` 与 `git commit --help` 不被该事件拦。定向测试退出 0。
5. 同一调用多条 user 规则命中：只采用第一条 deny，后续 user 规则不执行。定向测试退出 0。
6. 非法 `rules[].pattern`：构造期丢弃该条并走 `onHookError`（或等价观测），**不**导致所有工具 `[hook_error]`。定向测试退出 0。
7. `hooks.enabled: false` 时：`settings.memory.autoExtract === true` 仍按现约装配 auto-memory host 钩子（不因 hooks 总闸缺席）。回归：既有 auto-memory / secrets roundtrip 装配测试不因本 spec 默认路径变红。
8. `secrets.mode === "block"` 时 secrets-guard 仍挂在 Pre；`hooks.enabled: false` **不能**卸掉它。定向或装配测试退出 0。
9. TUI `onToolEvent` Post 与 user Pre 同时存在时互不覆盖（观测仍触发、user deny 仍短路）。定向测试退出 0。
10. 扫描超长 input：沿 #126 截断纪律（stringify 上限），超长尾部不扫描；不抛未捕获异常。定向测试退出 0。
11. `npm run typecheck` 与本模块相关测试（`npx vitest run tests/harness/hooks tests/config` 或计划落地的等价路径）退出 0。

## Open Questions

(none) — 假设闸由 operator 授权自判，条目见文末 Assumptions。

## Inherits / Changes

**Inherits**

- 5 步链顺序与 deny-only `PreToolUseHook` / 观测-only `PostToolUseHook`（`src/harness/permission/types.ts`，#126）。
- fail-closed / fire-and-forget（CONTEXT **hook failure semantics**）。
- ADR-0015 settings 单承载；非法字段丢弃不抛（`src/config/settings.ts` 纪律）。
- ADR-0004 / ADR-0006：钩子不改工具结果内容；`hook_error` / `hook_blocked` 走 `VIOLATION_PREFIXES`。
- ADR-0045 Decision 1：同进程 router，否决 fork/daemon/socket——本模块抄形态，不并入 sandbox server。
- Mutate 分类 SSOT：`classifyCall` / `FILE_WRITE_TOOL_NAMES`（ADR-0037 门禁，casual-ask 修订后的「会不会写工作区」）。
- 密钥默认 roundtrip（#406 / `settings.secrets.mode`）；block 才挂 secrets-guard。
- 自动记忆：`settings.memory` + TUI `/memory`（ADR-0031 / 0033）；`auto-hook.ts` 留在 memory 模块。
- 栈：TypeScript + Node；`npm test` / vitest；无本 spec 新依赖。

**Changes**

- 新增 `src/harness/hooks/` 能力模块；`build-engine` 改为 `createHookServer`（名可实施微调）产出 `{ pre, post }` 再交给 `createAciExecutor`。
- `settings` 增 `hooks` 段（仅 user hooks）。
- `createNoOpHooks` 可保留给测试；产品路径不再把「唯一 Pre」写成单函数覆盖。
- CONTEXT + ADR-0055（persist）。
- `specs/README.md` 活跃表加本文件；`docs/architecture.md` Capability 表加 Hook router 行（实施/docs 子弹，非本文件正文定义）。

**待写入（persist）**

- CONTEXT：`hook router`、`内置钩子（builtin hooks）`、`用户钩子（user hooks）`、`PreWrite (user hook event)`、`PreCommit (user hook event)`；关系条：user hooks vs 产品开关正交；hook router vs sandbox server。
- ADR-0055：同进程 hook router、内置/用户两类钩子、否决 OS daemon 与 Policy 巨兽、V1 不扫 hooks 目录。

## Assumptions

ASSUMPTIONS I'M MAKING（operator「自己判断」→ 视为 confirmed）：

1. 栈不变：TypeScript + Node + 现有 vitest；不加运行时依赖（不引入 jiti 加载用户 TS）。
2. V1 不实现目录装载；只留 contribution 接口，避免第二刀改 5 步链。
3. V1 无 TUI/Web 钩子 UI；操作员编辑 settings.json。
4. `settings.hooks.rules` 即 V1 启用集；不另做 `allow[]`（`allow[]` 留给文件源第二刀）。
5. Matcher：可选精确/前缀工具名 + 可选对扫描串的正则；PreCommit 另用 git 子命令检测器，不与 mutate 分类混用。
6. 子代理无独立 hooks 配置口，吃 merged settings。
7. ADR 编号 0055：仓库工作区已有未提交 `0054-phase2-model-draws-back-edges.md`。
8. 不把 violation kill-session、session JSONL commit hook 改造成 user 事件。
9. User Pre 在 checkPermission 之前（现 Step 1），deny 则 inner 零调用。
10. 人类审批：本 spec 无新「问用户」闸；拦了只回灌模型。

→ Corrected only if operator replies otherwise after landing.

## Architecture-change-reviewer

**affects:** `src/harness/hooks/`（新）、`src/config/settings.ts`、`src/harness/build-engine.ts`、permission 挂载点、`tests/harness/hooks/`、`docs/CONTEXT.md`、`docs/adr/0055-user-hook-router.md`、`specs/README.md`、`docs/architecture.md`。

正式 5 行块（PASS）见 `plans/user-hook-router.md`。

待写入清单已刷：CONTEXT 五词 + ADR-0055。
