# 用户钩子（user hooks）— settings.json 声明式 deny-only 拦截

> 操作员使用指南。SSOT = ADR-0055（`docs/adr/0055-user-hook-router.md`）+ `specs/user-hook-router.md`；
> schema 权威 = `src/config/settings.ts` 的 `IknowSettingsHooks`（勿以本表为准而以代码为准）。

---

## 一、一句话总结

在 `settings.json` 里声明 `hooks.rules[]`，iknow 引擎在每次工具调用**执行前**按规则判定是否拦截。deny-only：规则只能**拦**，不能放行或改写——内置安全层（hard-wall、secrets guard）不受影响。**默认关**：`enabled` 缺席或 `false` 时规则完全无效。

---

## 二、settings.json 模板

写在 `~/.iknow/settings.json`（全局）或 `<cwd>/.iknow/settings.json`（项目覆盖全局，per-field 合并）：

```jsonc
{
  "hooks": {
    "enabled": true,
    "rules": [
      {
        "id": "deny-git-commit",
        "event": "PreCommit",
        "reason": "本会话禁止提交，提交由人来做",
      },
      {
        "id": "deny-all-writes",
        "event": "PreWrite",
        "reason": "只读审查会话：任何写工作区的操作都拦",
      },
      {
        "id": "no-aws-keys",
        "event": "PreToolUse",
        "pattern": "AKIA[0-9A-Z]{16}",
        "reason": "调用参数疑似夹带 AWS key",
      },
      {
        "id": "no-github-mcp",
        "event": "PreToolUse",
        "pretooluse": "mcp__github",
        "reason": "禁止访问 GitHub MCP 工具",
      },
    ],
  },
}
```

拦截时模型收到的工具结果是 `execution_failed`，message 形如：

```
[hook_blocked] 本会话禁止提交，提交由人来做
```

模型不会重试同类动作，loop 继续运行。

---

## 三、字段参考（每条 rule）

| 字段         | 必填 | 说明                                                                            |
| ------------ | ---- | ------------------------------------------------------------------------------- |
| `id`         | ✅   | 规则标识，报错信息里用它定位坏规则                                              |
| `event`      | ✅   | `"PreToolUse"` \| `"PreWrite"` \| `"PreCommit"` 三选一                          |
| `reason`     | ✅   | 拦截时回灌给模型的文案（会出现在 `[hook_blocked]` 后面）                        |
| `tool`       | —    | 精确工具名，如 `"bash"` / `"write_file"`；缺席 = 任意工具                       |
| `pretooluse` | —    | 工具名前缀，如 `"mcp__github"` 命中 `mcp__github_create_issue`；缺席 = 任意工具 |
| `pattern`    | —    | 正则，对工具调用 input 的 JSON 串（截断 20000 字符）匹配；缺席 = 不做内容匹配   |

`tool` / `pretooluse` / `pattern` 同一条规则是 **AND** 关系：全部命中才拦；全都缺席 = 通配（任何调用都拦，慎用）。

### 三事件语义

| 事件         | 拦什么                                                                                                  | 典型例子                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `PreToolUse` | 按工具名 / 前缀 / 内容 pattern 拦任意工具调用                                                           | 拦 MCP 子集、拦内容含密钥的调用                                               |
| `PreWrite`   | 只拦**会写工作区**的调用（`write_file` / `edit_file` / `bash` 写命令等，复用 isolation 的 mutate 分类） | 只读会话禁写；`read_file` 永远不会被 PreWrite 拦                              |
| `PreCommit`  | 只拦 bash 中 `git commit` 形态的命令（含 `git -C <path> commit`）                                       | 禁止模型提交；`git status` / `git commit --help` / `git commit-tree` 不受影响 |

---

## 四、行为纪律（operator 该知道的）

- **默认关（fail-closed 解析）**：`enabled` 缺席 / 非 `true` / `rules` 非数组 → 所有规则无效，且不编译任何 pattern。
- **非法条目逐条丢弃，不抛错**：`id` / `event` / `reason` 缺失、`event` 拼错、`pattern` 不是合法正则的规则**整条剔除**，其余规则照常生效；剔除时 stderr 打 `[hook_error]` 告警（phase `user-rule-init`）。解析永不 crash 进程。
- **先拦先赢**：多条规则命中同一次调用时，只采用**数组顺序靠前**的那条 `reason`。
- **子代理同规则**：worker 子代理读同一份 merged settings（项目身份根下的 `.iknow/settings.json`），user 规则同样生效，无第二套后门。
- **产品开关正交**：`hooks.enabled: false` 不会关掉 auto-memory、secrets guard 等内置机制——它们有各自的开关。
- **热更新**：`hooks` 段不在热更新白名单，改完**需重启进程**生效。
- **v1 边界**：只支持 settings 文件源，不扫描 `~/.iknow/hooks/` 目录（文件源是下一刀）；只有 Pre 拦截，没有用户 JS/TS hook 模块。

---

## 五、调试

- 看拦截是否生效：模型收到 `[hook_blocked] <reason>` 的工具结果；TUI / trace 面板（`serve` 的 `/trace`）可见对应 `execution_failed`。
- 看规则是否被加载：stderr 的 `[hook_error] user-rule-init ...` 告警 = 有规则因 pattern 非法或字段缺失被剔除；没有告警 = 规则全部通过构造期编译。
- 单测参考：`tests/harness/hooks/user-hooks.test.ts`（各 matcher / 事件语义的判定边界都在那里钉住）。
