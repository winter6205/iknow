# 全局插件组件加载（skills / agents / hooks）

状态：ACR PASS（v2 复评 5 维全 yes，`OVERALL: PASS — hand to writing-plans`）
范围：`src/harness/plugin/`（新）、`src/harness/skill/`、`src/harness/subagent/`、`src/harness/hooks/`、`src/harness/permission/`、`src/harness/build-engine.ts`、`src/harness/subagent/worker.ts`、`src/config/settings.ts`、docs

## ACR 修订记录（v1 → v2）

| #   | 维度            | v1 缺陷                                                      | v2 处置                                                                                                       |
| --- | --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | bounded-context | 模块边界未闭合，未用既有 `HookContribution` 接缝             | §4.1 声明「plugin 只产数据、三装配面各自消费」+ 依赖方向；§5.2 以 `HookContribution` 为装配面                 |
| 2   | bounded-context | plugin roots 与 `session-roots.ts`「唯一根策略点」并存未说明 | §3.1 显式声明：plugin roots **不是**会话根，不受 ADR-0037/0019 约束，仅组件来源；不塞进 `resolveSessionRoots` |
| 3   | error-handling  | 降级路径无 typed 出口                                        | §7 扩展 `HookErrorEvent.phase` 闭集，加 `plugin-init` / `plugin-exec`；每个降级点标注出口                     |
| 4   | error-handling  | post 异步化未写拒绝路径（会冒 unhandledRejection）           | §5.7 逐个调用点写 `await` + try/catch；`violation-executor.ts:70` 单列                                        |
| 5   | complexity      | capability 侧第二 id 解析面漏接线                            | §6 接线表补 `capability.ts:76/107` 与 build-engine 侧默认工厂                                                 |
| 6   | complexity      | id 原样传递不变式未写                                        | §4.3 写明三段（enum / 模型传参 / manager）零 normalize 契约                                                   |
| 7   | minimal-change  | 一个任务捆绑两组独立特性                                     | §12 拆两刀：T1 discovery+skills+agents，T2 hooks；各自独立 commit                                             |
| 8   | minimal-change  | settings 键落点未定义                                        | §3.4 `plugins` **仅用户层**，项目层出现 drop + warn（供应链安全，见 §8）                                      |

## 1. 目标

让 iknow 读取本机全局安装的插件所携带的组件，并**完整使用**：

- **skills**：插件 skill 进 `<available_skills>`，`skill` 工具可加载正文；`<plugin>:<skill>` 与裸名都可解析。
- **agents**：插件 agent 进 `spawn_subagent` 的 enum 与 prose list，可派 `<plugin>:<agent>` 与裸名。
- **hooks**：插件 `hooks/hooks.json` 声明的命令钩子在工具调用 Pre/Post 时机真实执行；Pre 侧 exit 2 = 拦截。

判定面 = 本机已装插件（22 skills / 12 agents / 多 matcher 组 hooks）全部可用，且每个 matcher 组都能在对应 iknow 工具上触发。

## 2. 非目标

- 不实现插件的安装 / 克隆 / 更新 / 版本缓存管理（ledger 清单只读消费，写入面不在本次范围）。
- 不实现插件的 MCP server 装配。
- 不实现 commands / slash 命名空间。
- 不解析插件根下的 `.claude-plugin/plugin.json` 类私有清单——插件名与路径以 §3.2 的 ledger / 目录扫描为准。
- **Post 钩子不改变工具结果**（守 `permission/types.ts:153` 既有不变量）。
- 未知 hook 事件（PreCompact / SessionStart / Stop 等）不执行——iknow 没有对应时机，忽略 + 一次性 warn。

## 3. 发现层

### 3.1 根解析（不是会话根）

插件根由**用户配置**提供，产品代码不内置第三方路径。解析顺序（顺序合并去重）：

1. 显式注入 `opts.pluginRoots`（测试缝）。
2. 环境变量 `IKNOW_PLUGIN_ROOTS`（`path.delimiter` 分隔）。
3. 用户设置 `<home>/.iknow/settings.json` 的 `plugins.roots`。
4. 默认 `<userHome>/.iknow/plugins`（与 `~/.iknow/skills`、`~/.iknow/agents` 同构）——ledger 与插件都放这里。

**与 `session-roots.ts` 的关系（ACR #2）**：`session-roots.ts` 的「唯一策略点」管的是**会话根**（productRoot / taskRoot / installRoot / projectIdentityRoot，受 ADR-0037/0019 约束，随 worktree rebind 变化）。插件根是**组件来源路径**，与会话生命周期无关、跨 rebind 不变、不参与沙箱 fence 计算。二者正交：本能力**不修改** `resolveSessionRoots`，也不新增会话根角色。插件根解析住 `src/harness/plugin/roots.ts`，与 `skill/scanner.ts` 的 `IKNOW_SKILL_DIRS` 同层（同为「组件目录来源」），不上升为会话根。

根不存在 → 跳过（不告警）；未配置 → 等价本次改动之前。

### 3.2 插件识别：ledger 清单优先，目录扫描兜底

每个插件根 R 下可放一份 `installed_plugins.json`（ledger）：

```jsonc
{
  "version": 2,
  "plugins": {
    "<plugin>@<marketplace>": [
      {
        "scope": "user",
        "installPath": "<插件目录绝对路径>",
        "version": "0.12.1",
        "installedAt": "…",
        "lastUpdated": "…",
      },
    ],
  },
}
```

- **key 前段（`@` 之前）= 插件名 = 命名空间前缀**；`installPath` 直达插件目录（可指向版本化缓存 `<root>/cache/<marketplace>/<plugin>/<version>/`，也可指向任意放组件的目录）。
- 同 key 多条记录：取 `scope === "user"` 优先，否则取数组末项。
- `installPath` 缺席 / 非绝对 / 不可读 → 跳过该条 + warn（`plugin-init`）。
- JSON 损坏 → 跳过整个文件 + warn，落目录扫描兜底。

**无 ledger 时**目录扫描兜底——对根下每个直接子目录 D：

- D 含组件目录（`skills/` / `agents/` / `hooks/hooks.json` 任一）→ D 是插件，名 = D 的 basename。
- 否则若 D 恰有**一个**子目录 V 且 V 含组件目录 → 插件 = V，名 = D 的 basename。
- 否则跳过。

跳过规则（两路通用）：`node_modules/`、`.git/`、以 `.` 开头的条目、含 `:` 的条目（WSL 影子产物）、符号链接不跟随。

设计要点：ledger 给**精确名 + 任意深度路径**，扫描兜底给「扔个目录就能用」的零配置体验；两路输出同构（都是 `PluginInstallation[]`），下游无感知。命名空间之所以必须精确——skill 正文里以 `<plugin>:<agent>` 引用 agent，名字靠目录猜容易错，ledger 的 key 天然给出。

### 3.3 启用态

用户设置 `plugins.disabled: string[]`（插件名列表）→ 整体跳过。缺席 = 启用。

### 3.4 settings 落点（ACR #8）

`IknowSettings` 增 `plugins?: { roots?: string[]; disabled?: string[] }`。

- **仅用户层**：`PROJECT_SETTINGS_ALLOWED_KEYS` **不加入** `plugins`。项目层出现该键 → drop + warn（既有 allowlist 机制自动处理）。
- 理由（供应链安全）：插件会贡献 hooks = 任意命令执行。若项目层可配 `plugins.roots`，clone 一个仓库即等于让其执行任意代码。用户层的 `~/.iknow/settings.json` 不在版本控制内，是唯一可接受的**设置层**来源。
- **未闭合的旁路（ACR 复评指出，记入 ADR-0095）**：环境变量来源 `IKNOW_PLUGIN_ROOTS` 在设置层之外。node 启动器下安全——`config/env.ts` 把 `.env` 解析进本地 map，**从不写 `process.env`**（已核实无赋值点）。但 bun 启动器（`dev:tui` 等）会自动把仓库 `.env` 载入 `process.env`，于是「clone 即执行」在该路径下仍可能成立。判据：bun 路径执行的是 iknow 自身仓库（脚本信任已经主导），风险等同既有 `npm run` 系脚本；**不作为本次阻塞项**，但必须在 ADR 里写明，不得留 §3.4 的「唯一可接受来源」无限定语。

## 4. 组件装载

### 4.1 新模块 `src/harness/plugin/`（边界声明，ACR #1）

```
src/harness/plugin/
  roots.ts   # 根解析 + 插件目录识别 + 启用态过滤 → PluginInstallation[]
  catalog.ts # 一次扫描产出 { skillDirs, agentDirs, hooksFiles } 三面**数据**
```

**职责边界**：本模块**只产数据，不装配**。它不 import `skill/`、`subagent/`、`hooks/`、`permission/` 任何一个；三个组件主各自消费本模块的输出并保持自己既有的解析 / 命名 / 合并纪律：

```
plugin/roots.ts ──► PluginInstallation[]  (纯数据)
                       │
     ┌─────────────────┼─────────────────┐
     ▼                 ▼                 ▼
skill/scanner.ts   subagent/          hooks/  ← 各自扩展自己那一面
(追加 skill 根)     user-catalog.ts    (经 HookContribution)
                   (追加 agent 来源)
```

依赖方向（单向，无环）：`skill/subagent/hooks → plugin`，反向零依赖。与仓库既有纪律一致（`hooks/user-hooks.ts:38-42` 声明「hooks → permission（type-only）」的同款形态）。

不新增进程级全局状态：`plugin/catalog.ts` 的扫描结果由**装配层**（build-engine / worker）持有并传入，缓存由装配层决定（与 `user-catalog.ts:265` 的模块级缓存不同——那是既有实现，不在本次改动范围内动它）。

### 4.2 skills

`scanRoots()` 的 extras 之后追加每个插件的 `<root>/skills`（既有 `scanRoot` 按 `<root>/<name>/SKILL.md` 扫描，无需新扫描层）。

**优先级**（后者覆盖前者）：`~/.iknow/skills` < 项目 `.iknow/skills` < **插件** < `IKNOW_SKILL_DIRS`。

**命名**：规范名 = `<plugin>:<name>`。`SkillEntry` 增可选 `namespace?: string`；`createSkillCatalog` 索引同时登记规范名与裸名别名（裸名冲突 → 只留规范名 + warn）。`all()` / `available()` / `search()` 每 skill 只出一条（规范名），避免 listing 重复。

### 4.3 agents

`loadUserAgentEntries` 追加插件来源：`<plugin>/agents/*.md`（平铺形态，与既有 `~/.iknow/agents` 同构）。frontmatter 解析沿用既有（`description` / `bashMode` / `disallowedTools`）；其他键解析但不生效，未知键 warn 一次。

**id 模式**：`ROLE_ID_PATTERN` 放宽为 `^[A-Za-z0-9][A-Za-z0-9_:-]*$`（允许 `:`）。

**id 原样传递不变式（ACR #6）**：`catalog.get(role)` 的入参在三段之间**零 normalize、零 trim、零大小写折叠** ——（a）enum 由 `catalog.list()` 派生、（b）模型按 enum 原样传参、（c）handler 与 `resolveSubagentCapabilities` 原样透传。写入代码注释 + 测试断言（含「前后空格 id 不被接受」的负例），防止未来某段擅自规整造成三面漂移。

**命名**：规范 id = `<plugin>:<basename>`；同时登记裸名别名，仅当该裸名未与 builtin / 用户 agent / 其他插件裸名冲突，冲突则丢裸名 + warn。

**merge 顺序**：builtin < 用户 `~/.iknow/agents` < 插件；builtin 绝对权威（语义不变）。

**两处解析面必须同源（ACR #5）**：`spawn_subagent` 的 enum 派生面（`spawn-subagent-tool.ts:197`）与 capability 解析面（`capability.ts:76/107` 的 `resolveSubagentCapabilities` / `resolveBashMode`）都默认调 `createMergedCatalogResolver()`（`user-catalog.ts:288` 默认参数）。只改一处会造成「插件 id 进 enum 但 capability 查不到 → throw `AgentCatalogLookupError`」。接线表（§6）对两处**同时**注入同一 resolver 实例。

### 4.4 hooks 数据面

`plugin/catalog.ts` 只产出 `hooksFiles: string[]`（每个插件的 `hooks/hooks.json` 绝对路径）；解析与编译归 `hooks/`（§5）。

## 5. hook 契约

### 5.1 文件格式（消费面）

```jsonc
{
  "description": "…",            // 可选，忽略
  "hooks": {
    "PreToolUse":  [ { "matcher"?: "…", "hooks": [ { "type": "command", "command": "…", "timeout"?: 5 } ] } ],
    "PostToolUse": [ … ]
  }
}
```

只消费 `PreToolUse` / `PostToolUse`；其他事件名忽略 + 一次性 warn（记事件名）。`type` 只认 `command`，其他忽略 + warn。`timeout` 秒；缺席 → 30s；声明值上限 600s（超出截断 + warn）。

### 5.2 装配面：复用 `HookContribution`（ACR #1）

`hooks/index.ts:25` 已为「第二文件源」预留 `HookContribution { pre?, post? }`。本次实现即该接缝的第二刀：

**落点**：`src/harness/hooks/plugin-hooks.ts`。**不放** `src/harness/plugin/` —— 那会反转 §4.1 声明的单向依赖（plugin 不 import 任何组件主）。编译器归 `hooks/`，`plugin/` 只交文件路径数据。

```ts
// src/harness/hooks/plugin-hooks.ts
export function createPluginHookContribution(opts: {
  files: readonly string[];
  roots: ReadonlyMap<string, string>; // pluginName → root，供占位符替换
  userHome: string;
  projectDir: string;
  cwd: string;
  warn?: (m: string) => void;
  onError?: (e: HookErrorEvent) => void; // 复用既有 typed 通道
}): HookContribution;
```

返回的 `pre` / `post` 由装配层与既有 `composePreHooks([secretsGuard, userHook, pluginHook])` 同链组合。

### 5.3 matcher 求值

按字符类分流：

- 仅含 `[A-Za-z0-9_\- ,|]` → **精确备选匹配**（`|` 或 `,` 分隔，大小写敏感）。
- 含其他字符 → **非锚定 JavaScript 正则**（`RegExp.prototype.test`）。
- 缺席 / `""` / `"*"` → 通配。
- 非法正则 → 剔除该组 + warn（沿用 `user-hooks.ts` 纪律）。

**工具名候选集**（产品自有事实：iknow 工具扮演的通用角色）：

| iknow 工具       | 对外名                            |
| ---------------- | --------------------------------- |
| `bash`           | `bash`, `Bash`                    |
| `write_file`     | `write_file`, `Write`             |
| `edit_file`      | `edit_file`, `Edit`, `MultiEdit`  |
| `read_file`      | `read_file`, `Read`               |
| `grep` / `glob`  | `grep` / `glob` + `Grep` / `Glob` |
| `skill`          | `skill`, `Skill`                  |
| `spawn_subagent` | `spawn_subagent`, `Task`, `Agent` |
| 其余             | 仅原名                            |

`todo_write` **不**映射到 `Write`（账本工具非文件写，误映射会让写门禁误拦）。

### 5.4 stdin envelope

```json
{
  "hook_event_name": "PreToolUse" | "PostToolUse",
  "tool_name": "<候选集首个>",
  "tool_input": { … },
  "tool_response": "<Post：结果投影>",
  "session_id": "<conversationId，在场时>",
  "cwd": "<taskRoot>"
}
```

**`tool_input` 适配视图**：附通用别名字段（同名原生键优先，不覆盖）：

| 通用键                            | 来源                  |
| --------------------------------- | --------------------- |
| `file_path`                       | `path`                |
| `old_string` / `new_string`       | `old_str` / `new_str` |
| `skill`                           | skill 工具的 `name`   |
| `command` / `content` / `pattern` | 同名直传              |

### 5.5 退出码 → 决策

| exit | Pre                                                                                                  | Post                                  |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 0    | 放行                                                                                                 | 观测                                  |
| 2    | **拦截**：reason = stderr（优先解析 JSON 的 `systemMessage` / `permissionDecisionReason`，否则原文） | 观测 + 诊断通道（**不改变工具结果**） |
| 其他 | 放行 + warn 到 `plugin-exec`                                                                         | 同左                                  |

### 5.6 命令执行

- **占位符（品牌中立，后缀匹配）**：`${*_PLUGIN_ROOT}` → 插件根；`${*_PLUGIN_DATA}` → `<userHome>/.iknow/plugin-data/<plugin>`（首引即建）；`${*_PROJECT_DIR}` → `projectIdentityRoot`；其余 `${VAR}` 取进程环境，未定义 → 空串。同时把这些变量**导出**进子进程 env。
- 异步 `spawn`（`node:child_process`；先例 `lsp/server.ts`、`sandbox/runner.ts`）——`spawnSync` 会在 TUI 下阻塞事件循环。
- `shell: true`、`cwd: taskRoot`、stdin 写 envelope 后关闭、`timeout` 秒 → 毫秒。
- stdout / stderr 各截断 1 MiB。
- **fail-open**：命令不存在 / 启动失败 / 超时 / 非法退出码 → 放行 + warn（`plugin-exec`）。判据同 `user-hooks.ts` 顶部：钩子是可拦截面，误拦代价高于漏拦。

### 5.7 异步化与拒绝路径（ACR #4）

`PreToolUseHook` 返回类型放宽为 `PreHookBlock | undefined | Promise<PreHookBlock | undefined>`；`PostToolUseHook` 返回 `void | Promise<void>`。**逐调用点**处置：

| 调用点                                                       | 现状                                     | 处置                                                                                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `permission-executor.ts:275`（`gateOne`，async）             | `hookDecision = pre({...})`              | `hookDecision = await pre({...})`；既有 try/catch 覆盖 async 抛错，fail-closed 语义不变                                                                                                    |
| `permission-executor.ts:403`（`runAllowed`，async）          | `try { post({...}) } catch` **不 await** | `try { await post({...}) } catch { onHookError(...) }` —— **必须 await**，否则 rejected promise 逃出 try 成 unhandledRejection。语义仍 fire-and-forget（结果不变），仅把拒绝收进既有 catch |
| `sandbox/violation-executor.ts:70`（`observe`，同步 `void`） | `hook({...})`                            | 该闭包签名是 `(r, i) => void`；改为 `async` 并在调用处 `await`（`executeAll` 本已 async）。若不改，异步 post 的拒绝无人接。                                                                |

`composePreHooks` 改为 async 顺序组合（先拦先赢不变）。

既有同步实现（`secrets-guard` / `user-hook-router` / TUI post / `createKillSessionHook`）**零改动**。

## 6. 装配接线

| 位置                       | 改动                                                 |
| -------------------------- | ---------------------------------------------------- |
| `build-engine.ts:727`      | skill scanner 传插件 skill 根                        |
| `build-engine.ts:1448`     | Pre 链追加 plugin hook                               |
| `build-engine.ts:1463`     | Post 链追加 plugin hook（与 TUI 观测并存）           |
| build-engine spawn 工具    | resolver 注入插件 agent 来源（**与下一行同一实例**） |
| `capability.ts:76` + `107` | 经注入的同一 resolver（ACR #5）                      |
| `worker.ts:415`            | skill scanner 同上                                   |
| `worker.ts:508`            | Pre 追加 plugin hook                                 |
| `worker.ts:365`            | agent catalog 同上（worker 侧 resolver 单一入口）    |
| `settings.ts`              | `plugins` 段 +（**不**加入项目 allowlist，§3.4）     |

父引擎与 worker 必须同源：两条路径都从 `plugin/` 取同一索引。

## 7. 降级路径与观测出口（ACR #3）

`HookErrorEvent.phase` 闭集扩展：

```ts
readonly phase: "pre" | "post" | "guard-init" | "user-rule-init"
              | "plugin-init"   // 扫描/解析期：根不可读、hooks.json 非法 JSON、matcher 编译失败、未知事件
              | "plugin-exec";  // 执行期：spawn 失败、超时、非 0/2 退出码、输出截断
```

对接既有两条通道：

- 父引擎：`opts.onHookError`（`build-engine` 已透传）。
- worker：`process.stderr.write`（复用 `worker.ts:508` 既有的 `[worker user-rule-init]` 同款形态，改前缀为 `[worker plugin-*]`）。

每个降级点在代码中带 `// EXIT:` 标注（仓库既有 161 处先例，见 `permission-executor.ts:333`）。**不静默**：至少一条 warn；不可读根除外（未配置是合法态，非降级）。

## 8. 安全边界

- **项目层不可配插件根**（§3.4）：防「clone 即执行」供应链攻击。这是本设计最重要的一条边界。
- **只读插件目录**：不写、不改、不复制（`plugin-data` 除外，且仅首引时创建）。
- **命令执行面**：hook 命令由用户本机已装插件声明；iknow 已能经 `bash` 执行任意命令，本能力不扩大信任面。命令串原样交 shell（重写会破坏插件语义）。
- **cwd** = `taskRoot`；**不过 bwrap 沙箱**（与插件在实际使用中的形态一致），但也不额外授予权限。
- **不读凭据**：本能力只读组件文件（`skills/` / `agents/` / `hooks/hooks.json`），不读其他文件。
- **warn 只输出路径与原因**，不输出命令输出全文。

## 9. 测试矩阵

| 面         | 测试                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| roots      | 无根 / 多根去重 / 根不存在 / 两种插件布局 / 版本化嵌套 / `.` 与 `:` 条目跳过 / `disabled` 过滤 / 项目层 `plugins` 键被 drop                        |
| skills     | 插件 skill 进 catalog；规范名 + 裸名都可 `get`；listing 不重复；同名覆盖 + warn；无插件根时字节级等价既有行为                                      |
| agents     | 插件 agent 进 merged catalog；规范 id + 裸名；裸名冲突丢弃；builtin 权威；非法 id 拒绝；**id 原样传递**（含空格负例）；enum 与 capability 两侧同源 |
| hooks 解析 | 非法 JSON / 缺 `hooks` / 未知事件 / 非 command 类型 / 超时值越界 → warn + 跳过；`plugin-init` 出口                                                 |
| matcher    | 精确类 `Write\|Edit` 命中 `edit_file`、不命中 `todo_write`；正则类 `Edit.*` 非锚定；通配；非法正则剔除                                             |
| hooks 执行 | exit 0/2/其他；JSON 与纯文本 stderr；超时；envelope 字段（含别名）；四种占位符；输出截断；`plugin-exec` 出口                                       |
| 异步       | pre 异步抛错仍 fail-closed；**post 异步拒绝被 catch 且不产生 unhandledRejection**；violation-executor 路径                                         |
| 装配       | build-engine 与 worker 两路接入（fixture 插件根）；`composePreHooks` 异步短路顺序                                                                  |
| 回归       | 既有同步 hook 实现零改动通过（permission / secrets-guard / user-hooks / violation 既有测试）                                                       |

## 10. 验收

1. `npm test` 全绿（含新增）。
2. `mcp__aiterm__pty_*` 起真实 TUI：**插件根由操作员配置**（`IKNOW_PLUGIN_ROOTS` 环境变量或 `~/.iknow/settings.json` 的 `plugins.roots`，不写进仓库任何文件）。验证：
   - 插件 skill 进 `<available_skills>`；`skill` 工具加载正文成功。
   - `spawn_subagent` 派发插件 agent（命名空间 id）成功。
   - 插件 hook 真实触发（Pre 拦截 + 放行两侧）。
3. `npm run test:real-llm`。
4. `arthurpower:code-review` 双轴通过。

## 11. 留档

新 ADR（0095）：插件组件加载的根来源（含「仅用户层」的供应链判据）、命名空间、hook 契约、fail-open 判据、Post 不改变结果的边界、与 `session-roots.ts` 的正交关系。更新 `docs/guides/skill-authoring.md`（skill 根与优先级）、`docs/guides/user-hooks.md`（第二文件源）、`docs/architecture.md`（新模块）、`docs/STATUS.md`。

## 12. 任务拆分（ACR #7）

| 刀     | 范围                                                                                                                    | 独立可验证                                  | commit                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| **T1** | `plugin/roots.ts` + `catalog.ts`（skills/agents 数据面）、scanner 接线、agent 两处解析面、settings `plugins` 键         | 插件 skill 可加载 + 插件 agent 可派发       | `feat(plugin): 全局插件 skills/agents 加载`   |
| **T2** | `hooks.json` 解析与编译、`HookContribution` 装配、`permission/types.ts` 异步放宽、三处调用点处置、`HookErrorEvent` 扩展 | 插件 hook 触发与拦截 + 既有同步 hook 零回归 | `feat(plugin): 插件 hooks 文件源与异步钩子链` |

两刀合并为一个 PR（同一目标：完整使用插件组件），但各自自洽、可独立回滚。

## 13. 取舍记录

- **ledger 清单优先、目录扫描兜底**：ledger（`<root>/installed_plugins.json`）给精确插件名（命名空间正确性依赖它）与任意深度 installPath；扫描兜底给零配置体验。格式是 iknow 自有全局目录（`~/.iknow/plugins/`）内的约定，与既有 `~/.iknow/skills` / `~/.iknow/agents` 同一家族。
- **不内置第三方路径**：根完全由配置/环境提供，仓库内不出现特定第三方目录字面量；第三方插件经用户层配置/ledger 指入。
- **占位符按后缀匹配**：兼容既有插件文件而不在代码写死第三方品牌前缀。
- **Pre 异步、Post 不注入**：前者功能必需，后者守既有不变量。
- **fail-open**：与 `user-hooks.ts` 同判据（宁可漏拦不误拦）。
- **plugin 模块只产数据**：三个组件主各自持有解析与合并纪律，避免出现第四个「知道所有组件」的上帝模块。
