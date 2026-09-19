# 用户钩子（user hooks）— settings.json Claude command 形态

> 操作员指南。Schema = `src/config/settings.ts` 的 `IknowSettingsHooks`。
> 运行时编译与插件 `hooks/hooks.json` 同一套（`createSettingsHookContribution`）。

---

## 一句话

在用户层 `~/.iknow/settings.json` 写 Claude 同款 `hooks.PreToolUse` / `hooks.PostToolUse`：`matcher` + `{ type: "command", command, timeout? }`。引擎在工具执行前/后 spawn 该命令。Pre **exit 2** 拦截；其余退出码 fail-open。项目 `.iknow/settings.json` **不采纳** `hooks`（任意 shell = clone 即执行）。

---

## 模板

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node --experimental-strip-types /home/you/.iknow/hooks/pre-tool-guard.ts",
            "timeout": 5,
          },
        ],
      },
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "npx prettier --write \"$f\"" },
        ],
      },
    ],
  },
}
```

stdin 是 JSON envelope（`hook_event_name`、`tool_name`、`tool_input` 含 `file_path` 等别名、`cwd`）。Pre 拦：stderr 优先 JSON 的 `systemMessage` / `permissionDecisionReason`，否则原文；模型看到 `[hook_blocked] …`。

`timeout` 单位秒，缺省 30，上限 600。

未知事件名（`SessionStart` 等）忽略。非 `command` type 忽略。

---

## matcher

与插件 hooks 相同：只含 `[A-Za-z0-9_ ,|-]` → 精确备选（`Write|Edit`）；含其他字符 → 正则。缺席 / `*` → 通配。工具名候选集：`bash`↔`Bash`，`write_file`↔`Write`，`edit_file`↔`Edit|MultiEdit`，`read_file`↔`Read`，等等。

---

## 纪律

- 仅用户层。项目文件出现 `hooks` → 丢弃并 warn。
- 段缺席 = 无用户 command 钩子。没有 `enabled` 总闸。
- 链序：builtin（secrets）→ settings command → 插件 command。Post：TUI 观测 → settings Post → 插件 Post。
- 改完需重启进程。
- 不扫描 `~/.iknow/hooks/` 目录；脚本路径自己写在 `command` 里。
- 旧 `{ enabled, rules }` deny-only **不再生效**。
