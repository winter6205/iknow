# 0084. 项目 settings 允许名单；权限 SSOT 进 JSON

Date: 2026-09-11
Status: accepted

用户层 `~/.iknow/settings.json` 与共享项目层 `<仓>/.iknow/settings.json` 仍是仅有的两层文件（无第三层 local）。ADR-0015「project 盖 user」收窄为：**项目文件只采纳** `hooks`、`verify`、`secrets`、`permissions`。其余顶层段（含 `isolation` / `llm` / `memory` / `subagent` / `web` / `lsp` / `loop` / `graph`）出现在项目文件 → 丢弃、不覆盖用户值，启动可见警告。

写回落对层：用户层键只写用户文件；不得因「项目文件已存在」把 thinking 等写入项目。

权限机械层从 `permissions.toml` 迁入项目 `settings.permissions`。**停读 toml**。两份同时存在 → 启动/加载 fail-loud。用户层不接 `permissions`。

> **Amendment 2026-09-13**（ADR-0090）：上段「谓词语义不换成字符串列表」**superseded**。允许名单、停读 toml、用户层不接 permissions 仍有效。现行规则形态 = **声明式权限规则**（`allow`/`ask`/`deny` 字符串）。

**Why not 项目继续盖 isolation / llm：** 一次项目 `isolation: false` 会卸掉全员门禁或（旧装配下）卸掉工作树工具，把个人开关变成仓库契约。允许名单把团队契约（钩子、校验、密钥、权限）与个人运行时（模型、隔离、子代理）切开。

**Why not 第三层 local：** 两层已够「共享 vs 个人」；再加一层只增加覆盖顺序与写回歧义。

关联：CONTEXT **项目 settings 允许名单**。
