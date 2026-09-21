# 0095. 全局插件组件加载：ledger 优先、目录扫描兜底、hook 文件源第二刀

Date: 2026-09-14
Status: accepted

iknow 增加读取本机全局安装插件所携带组件（skills / agents / hooks）的能力。

## 决议

1. **插件根不是会话根**：`~/.iknow/plugins`（默认，与 `~/.iknow/skills` / `~/.iknow/agents` 同构）+ `IKNOW_PLUGIN_ROOTS` env + 用户设置 `plugins.roots`。与 `session-roots.ts` 的会话三根正交——插件根是组件来源路径，跨 worktree rebind 不变，不进 `resolveSessionRoots`。
2. **发现 = ledger 优先、目录扫描兜底**：`<root>/installed_plugins.json`（`<plugin>@<marketplace>` → installPath/version/scope）给精确插件名与任意深度路径；无 ledger / JSON 损坏 → 目录扫描（含 `<root>/<plugin>/<version>/` 嵌套布局）。命名空间精确性依赖 ledger key——插件 skill 正文以 `<plugin>:<agent>` 引用 agent，目录猜名会错。
3. **命名空间 id**：skill 与 agent 均登记规范名 `<plugin>:<name>` + 裸名别名（冲突丢弃 + warn）；agent 的 `ROLE_ID_PATTERN` 放宽允许 `:`。id 三段（enum / 模型传参 / capability）**原样传递零 normalize**。
4. **hook 文件源第二刀**：`HookContribution`（`hooks/index.ts` 预留接缝）落地为 `hooks/plugin-hooks.ts`——`hooks/hooks.json` 的 `PreToolUse` / `PostToolUse` 编译为异步子进程钩子。matcher 按字符类分流（精确备选 vs 非锚定正则）；iknow 工具名映射到对外名候选集（`write_file`→`Write`、`edit_file`→`Edit|MultiEdit`；`todo_write` **不**映射 `Write`）；envelope 附通用键别名（`file_path`←`path` 等）；`${*_PLUGIN_ROOT}` / `${*_PLUGIN_DATA}` / `${*_PROJECT_DIR}` 按后缀替换并导出 env。exit 2 = Pre 拦（stderr JSON `systemMessage`/`permissionDecisionReason` 优先）；其余 fail-open。
5. **钩子链异步化（additive 类型放宽）**：`PreToolUseHook` / `PostToolUseHook` 返回类型允诺 Promise；`permission-executor` 两个调用点与 `violation-executor` 的 observe 全部 `await`（post 拒绝必须进 catch，否则 unhandledRejection）；`composePreHooks` 异步先拦先赢。既有同步钩子零改动。
6. **`plugins` 仅用户层**：不进 `PROJECT_SETTINGS_ALLOWED_KEYS`。插件贡献 hooks = 任意命令执行；项目层可配插件根等于 clone 即执行（供应链）。bun 启动器会把仓库 `.env` 自动载入 `process.env`，`IKNOW_PLUGIN_ROOTS` 旁路在该路径仍可达——判据：bun 路径执行 iknow 自身仓库，脚本信任已主导，风险等同既有 `npm run` 系；记录于此，不作代码阻塞。

**Why not 解析 `.claude-plugin/plugin.json` 类插件清单**：绑定第三方私有 schema；ledger + 目录扫描对两种安装布局同构，半装自然降级。
**Why not `spawnSync` 执行 hook**：TUI 下每工具调用串行阻塞事件循环不可接受。
**Why not Post 改变工具结果**：`PostToolUseHook`「observability only」既有不变量不动。
**Why not fail-closed**：钩子是可拦截面，误拦代价高于漏拦（与 user-hook-router 同判据）。

Amends ADR-0055（hook 文件源 H1 第二刀落地）。
