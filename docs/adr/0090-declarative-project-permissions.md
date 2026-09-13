# 0090. 项目权限规则改为声明式字符串列表

Date: 2026-09-13
Status: accepted

项目 `settings.permissions` 不再使用 `schema_version` + `rule[]` 谓词 DSL。操作员写 `allow` / `ask` / `deny` 字符串（`Tool` / `Tool(specifier)`），可选 `defaultMode`（仅 `default` | `plan`）。加载编译为既有 `NormalRuleSpec`；同层 **deny → ask → allow**。旧形态与项目 `full_auto` 均 fail-loud。用户层仍不接 `permissions`；toml 双源仍按 ADR-0084 fail-loud。#1004。

**Why not 保留谓词 DSL：** 入库后每条要写 id/tool/decision/reason，九个固定谓词加不出 glob，和 hooks 段形态分裂。

**Why not 双形态并存读取：** 与 toml→json 同一纪律——两套 SSOT 会让「到底哪条生效」不可审计。

**Why not 项目文件写 `full_auto`：** 共享仓库不得把自动模式变成团队契约；自动模式仍是操作员会话选择（ADR-0032）。

关联：ADR-0084（允许名单与权限家仍在项目 settings；本 ADR 只换规则形态）；`specs/declarative-project-permissions.md`。
