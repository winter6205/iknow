# 0025. 用户画像与首启引导永远只在全局 home

Date: 2026-08-21
Status: accepted

ADR-0019 D1.4 把 `user.md` / `BOOTSTRAP.md` 绑到 `workspaceRoot`，每个启动根目录都会 seed 一份空画像。操作员契约是画像永远全局一份：identity 文件（`user.md`、`BOOTSTRAP.md`、记录 `bootstrap_seeded` 的 `state.json`）物理根 = `userHome/.iknow`（默认 `homedir()`）。`--workspace-root` 只隔离 settings 写回 fallback；**不**隔离会话记录、tasks 与项目记忆（ADR-0087 / ADR-0088 / ADR-0099），也不搬走画像。测试隔离走注入的 `userHome`。不自动删除已误种在项目 `.iknow/` 的文件。ADR-0019 D1.1–D1.3 与 D1.5 不变。
