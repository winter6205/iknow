# G4 用户层 vs 共享项目层 settings

- Map: [主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）](../agent-control-surface-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-11)
- Blocked by: —

## Question

两层 settings 文件已在，缺的是键归属和权限家在哪。要不要第三层个人覆盖？权限还住 toml 吗？

## Resolution

操作员裁（2026-09-11）：

1. **不做第三层**个人覆盖文件。只做用户层 `~/.iknow/settings.json` 与共享项目层 `<仓>/.iknow/settings.json`。
2. **项目允许名单 + 写回落对层**：harness 键（isolation、模型/key/超时、subagent、web、lsp、memory、thinking）只准用户层；项目文件出现则丢弃且不覆盖用户值。项目可写：团队 hooks、verify、以及权限。面板写回不得把用户层键写入项目文件。
3. **权限搬家**：现有 `permissions.toml` 的 rule DSL（`match_tool` / `match_input` 谓词 / allow|deny|ask）迁入项目 settings 的 `permissions` 字段，**停读 toml**；两份同时存在启动 fail-loud。用户层这一刀不接权限。不另做简化 allow 字符串列表。

> **Amendment 2026-09-13**（#1004 / ADR-0090）：末句「不另做简化 allow 字符串列表」**superseded**。搬家与双源 fail-loud 仍有效；现行形态见 `specs/declarative-project-permissions.md`。

落地另开 spec；本票只记账。待写入：ADR（键归属闸 + 权限 SSOT 从 toml 迁到项目 settings）。
