# 0032. 产品口「自动模式」只指权限 full_auto；`/goal` 续跑叫 goal 功能

Date: 2026-08-27
Status: accepted

CONTEXT 曾把「自动模式」写成 `/goal` 无人值守环，和权限轴 Shift+Tab 的 Auto（`full_auto`）撞名。产品裁定：自动模式只有权限那一个；钉上 `/goal` 后的续跑仍保留，只叫 **goal 功能**，不是模式。开/关只认斜杠（`/goal <text>` / `/goal clear`），`## GOAL:` 不是产品入口。ADR-0024 的两套判官模块仍有效，文中旧称「自动模式」= 本文的 goal 功能。

## Why not

- **把 goal 续跑也叫自动模式 / 全自动模式**：和权限 Auto 同一词，操作员会以为 Shift+Tab 开了 goal。
- **`## GOAL:` 与斜杠双入口**：产品只要斜杠；消息正文钉 goal 会让「命令消失」无法解释。
