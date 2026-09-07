# 审计报告：HTML 被写入 skill 目录的根因

- 日期：2026-09-07
- 审计会话：`8fc8c295-6aea-48e8-a6a7-e1aa24bfe832`（NORDLYS 1785 奢侈品手表 showcase，绑定 worktree `nordlys-watch-showcase`）
- 触发：用户要求调查「奢侈品 HTML 编写会话为什么把 HTML 写进 skill 目录内部」

## 现象

用户请求「编写一个精美的 3D 无依赖奢侈品手表 html」，产出物 `nordlys-n01.html`（65KB）及其配套 `DESIGN_SPEC.md`、`preview-hero.png` 没有落在常规输出位置，而是写进了 `.iknow/skills/design-taste-frontend/showcase/`。该目录因 `.gitignore` 反白（`!.iknow/skills/**`）出现在 `git status` untracked 列表，形成仓库污染。

## 根因（一句话）

host 注入 skill 时给出的 `Base directory: /home/winner/projects/iknow/.iknow/skills/design-taste-frontend` 是上下文中唯一被官方指认的路径，而项目没有「产出物输出位置」约定，agent 在选址推理中把 skill 目录当成了 demo 的合理归宿。

## 证据链

1. **注入**：会话首条 user 消息由 host 注入完整 `design-taste-frontend` skill，`Base directory` 指向 `.iknow/skills/design-taste-frontend`。
2. **选址推理**（trace line 10 原文）：
   > "the cleanest place is `.../.iknow/skills/design-taste-frontend/showcase/nordlys-n01.html` — keeps it in the skill directory as a demo of what this skill produces. Wait, no. ... Actually I think the best is ... Let me create a `showcase/` folder under the skill."
3. **落盘**：`nordlys-n01.html`、`DESIGN_SPEC.md`、`preview-hero.png` 写入 worktree 内的 `.iknow/skills/design-taste-frontend/showcase/`。
4. **放大器**：`.gitignore:138-139` 显式反白 `!.iknow/skills/**`，skill 目录下的一切（含展示产物）进入 git 可见范围。
5. **澄清**：主仓 `.iknow/skills/design-taste-frontend/SKILL.md`（09:44 创建，会话开始前 2 小时）是 skill 本体（SKILL.md + references/，无 showcase），不是本次会话写入；09:44 前后的会话记录为空（一个 0 turn，一个误触），本体来源为 skill 安装/同步动作。

## 结论与改进方向

按 fin `prompt-development.md` 的「硬闸先于软分」原则：agent 对注入路径的亲近偏置是纪律句压不住的行为，应在环境/工具层加硬约束，不靠 system 追加一句「别写进 skill 目录」。

1. **host 硬约束（首选）**：skill-load 注入时明确「skill 目录只读，产出物写到 X」（任务 prompt 或注入模板带 output-location 字段）。
2. **项目约定固化 scratch/demo 输出目录**（如 `docs/demos/` 或任务 worktree 根），并在 skill 注入文案中指向它。
3. **gitignore 语义收紧**：`!.iknow/skills/**` 反白本意是让 skill 本体可提交，但把 skill 目录下的一切（含未来误写的产物）都放进了 git 可见范围；可评估改为白名单式（只反白 SKILL.md 与 references/）。

## 修复状态

- 根因已定位（本报告）。
- 防回归硬闸未实施（属 host/项目约定层改动，需单独任务）。
- 本次仅附带动作：fin 的 `docs/guides/prompt-development.md` 已复制到本仓 `docs/guides/` 作为 prompt 开发规范起点（commit 20f23552，worktree 分支）。
