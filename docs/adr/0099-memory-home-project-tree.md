# 0099. 项目记忆落 home 项目树 `projects/<slug>/memory/`

Date: 2026-09-18
Status: accepted

## Context

会话记录与后台任务登记已按 `projectIdentityRoot` 落在 `<dataDir 或 ~/.iknow>/projects/<slug>/`（ADR-0087 / ADR-0088）。项目记忆库仍按 ADR-0019 落 `<workspaceRoot>/.iknow/memory/<slug>`，同一项目在全局项目树里有会话，记忆却在另一棵工作区树上。操作员期望记忆跟其它项目归类一样，串在该会话项目目录下。

## Decision

项目记忆库 = `<dataDir 或 ~/.iknow>/projects/<slug>/memory/`，与会话叶子、`tasks/` 同 slug。不再跟 `workspaceRoot` 分片。`--workspace-root` throwaway 不再隔离项目记忆；另池用 `--data-dir`。工作区存量不自动迁移。用户层 `AGENTS.md` / `resolveUserMemoryDir` 不在本决策内。

## Why not

**Why not 继续 per-root：** 多份 checkout 各开一份记忆；浏览 home 项目树看不到该项目的记忆。

**Why not 自动搬运工作区 `.iknow/memory/`：** 与 ADR-0088 会话存量同口径；旧布局在 memory 下再套 slug，新布局是 slug 下的 memory/，静默 rename 易撞已有目标。

## Consequences

- (+) 浏览 `~/.iknow/projects/<slug>/` 能同时看到会话叶子、`tasks/`、`memory/`。
- (−) 旧工作区记忆库对新进程不可见，需手迁。
