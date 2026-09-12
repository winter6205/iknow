# Spec: 声明式项目权限规则

> **Lean spec.** 决议 SSOT = ADR-0090 + CONTEXT **声明式权限规则**。本文件钉操作员可见形态、匹配合同、迁移与验收。权限链层序仍是 `security-guardrails.md` / `policy.ts`（hard-wall → session > project > code → mode）。#1004。
>
> **Amends:** `agent-control-surface.md` Slice B「不另做 allow 字符串列表」；`security-guardrails.md` 项目 `permissions` 承载谓词 `rule[]` 的读法。ADR-0084 的允许名单 / 停读 toml / 用户层不接 permissions **不变**；其中「谓词语义不换成字符串列表」由 ADR-0090 取代。

## Glossary（exact copy from docs/CONTEXT.md，不重定义）

- **声明式权限规则**
- **项目 settings 允许名单**
- **自动模式**（`full_auto`）

## Objective

**What:** 项目 `<仓>/.iknow/settings.json` 的 `permissions` 段改为 `allow` / `ask` / `deny` 字符串列表 + 可选 `defaultMode`。每条规则是 `Tool` 或 `Tool(specifier)`。加载后编成既有 `NormalRuleSpec`，不新开决策轴。

**Why:** 入库后的谓词 DSL（`id` / `match_tool` / `match_input` / `decision` / `reason`）不可维护；与 `hooks` 段的声明式风格也不一致。

**Who:** 共享仓库的操作员（写项目 settings）；harness 权限加载。

**Success:** 见 Success Criteria。

## Does

- 三档分组；空数组合法；三段都缺 = 无项目规则。
- 规则语法 `Tool` 或 `Tool(specifier)`。`Tool(*)` 等价于裸 `Tool`。
- 同项目层评估顺序：**deny → ask → allow**；同档先命中先赢，不比「更具体」。
- 模式名（大小写不敏感）映射到 ACI 工具，不要求操作员写 `read_file`：
  - `Bash` → `bash`（specifier 对 `command`）
  - `Read` → `read_file` / `grep` / `glob`；路径 deny 同时挡住同路径的 `edit_file` / `write_file`（含新建）
  - `Edit` → `edit_file` / `write_file`
  - `WebFetch` → `web_fetch`（`domain:host` 匹配 URL 主机）
  - 其余：字面等于 ACI `def.name`（含 `mcp__…`）
- `Write(path)` 等「非 Read/Edit 的路径规则」加载时警告且**不参与**路径检查；无 specifier 的裸 `Write` 仍按工具名匹配。
- Bash specifier：`*` 任意位置；尾缀 `:*` 等价于末尾 ` *`；`cmd *` 有词边界（`ls *` 不配 `lsof`）。复合命令按 `&&` `||` `;` `|` `|&` `&` 与换行拆开，**每段都要独立命中**才算整条命中。匹配前剥固定 wrapper：`timeout` / `time` / `nice` / `nohup` / `stdbuf` / `command` / `builtin` / `noglob` / 无 flag 的 `xargs`。
- 路径 specifier：gitignore 风格。`Read(.env)` 与 `Read(**/.env)` 等价。`//` 文件系统绝对；`~/` home；单斜杠 `/` 相对 **projectIdentityRoot**；无前导斜杠相对当前工作根。deny/ask 的单段目录（如 `secrets/**`）在工作根下任意深度命中；allow 只锚在该段顶层，任意深度须写 `**/secrets/**`。大小写敏感；分隔符归一为 `/`；隐藏文件参与匹配。
- deny/ask 的工具名位允许 glob（`*`、`mcp__*`）；allow 的工具名 glob 仅允许 `mcp__<server>__*`（server 段无 glob）。未知工具名的 deny/ask 启动警告。
- deny/ask 可写 `Tool(param:value)` 匹配顶层标量输入（`*` 通配值）；**禁止**用此语法匹配主内容字段（Bash `command`、Read/Edit 路径、WebFetch `url`）——加载警告并忽略该条。allow 不走 param:value。
- `id` / `reason` 不出现在文件里；编译时生成。
- `defaultMode` 可选，值域 `default` | `plan`。只种子**启动** `PermissionMode`；CLI / `IKNOW_PERMISSION_MODE` / `/permissions` / Shift+Tab 覆盖。项目文件写 `full_auto` → 加载 fail-loud（仓库不得自授自动模式）。缺席 = 不改启动 mode。
- 旧形态（`schema_version` / `rule`）→ 加载 typed fail-loud，错误含新形态示例。不双读。toml 并存仍按 ADR-0084 fail-loud。
- 用户层仍不接 `permissions`。hard-wall、session grants、hooks、code 内置（含 `bash` `network:true` ask）层序不变。

## Does not

- 不与 `hooks.rules[]` 合并；hooks 仍是默认关、deny-only、event/正则。
- 不新增 `acceptEdits` / `dontAsk` / `bypassPermissions` 等 mode。
- 不把用户层做成第三份权限 SSOT。
- 不削弱 hard-wall。
- 不要求自动改写旧 JSON 的迁移脚本（本仓规则手改）。

## 与 hooks 的边界

| 段            | 职                                                      |
| ------------- | ------------------------------------------------------- |
| `permissions` | 工具调用的 allow/ask/deny 政策（团队契约，默认生效）    |
| `hooks`       | 额外拦截（内容正则 / PreWrite / PreCommit），总闸默认关 |

路径与命令政策写 `permissions`；「参数里像密钥」写 hooks。

## Success Criteria

命令以本 worktree 仓库根为准。

1. 本仓 `.iknow/settings.json` 仅为新形态；能表达今日 echo 前缀 allow 与 `.ssh` 路径 deny，以及 `Read(**/*.pem)`。`npx vitest run tests/harness/permission/project-settings.test.ts tests/config/settings.test.ts tests/harness/permission/policy.test.ts` 退出 0。
2. 旧 `rule[]` 加载 typed fail；空 `allow`/`deny` 合法。
3. 同文件一条 deny 压过一条 allow；hard-wall 仍压过项目 allow。
4. `Bash(git status:*)` 命中 `git status` / `git status -sb`；不命中 `git status && rm -rf /tmp/x` 整串（复合须分段都匹配）；`Bash(ls *)` 不命中 `lsof`。
5. `Read(.env)` deny 挡住 `read_file` / `grep` / `glob` 以及同路径 `edit_file`/`write_file`。
6. 项目 `defaultMode: "full_auto"` 加载失败；`default`/`plan` 只影响启动种子。
7. 既有 hard-wall / session grants / `network:true` code 层 ask / hooks 测试不因本票改合同而红（除非断言仍绑 `rule[]` 形状——那些断言随本票改写）。
