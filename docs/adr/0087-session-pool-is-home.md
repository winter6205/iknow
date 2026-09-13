# 0087. 会话池根是 home，不跟 workspaceRoot 分片

Date: 2026-09-13
Status: accepted

## Context

ADR-0071 Decision 1 把会话文件夹钉在 `~/.iknow/projects/<slug>/<conversationId>/`。ADR-0019 T2 却让 `resolveServeDataDir` 在有 `workspaceRoot` 时落到 `<workspaceRoot>/.iknow`。TUI / serve 把会话 jsonl 与 blobs 写进工作区，grep 用 `--no-ignore` 扫工作区时命中刚写进 transcript 的 pattern（#1000）。`workspaceRoot` 词条一度把 sessions 算进 per-root，和「会话文件夹」词条冲突。

## Decision

**会话池根 = 显式 `--data-dir` / `dataDir`，否则 `~/.iknow`。不跟 `workspaceRoot` 分片。**

`resolveServeDataDir` 不再读第二参。TUI / serve / chat / trace 读写侧同一公式。`--workspace-root` 仍锚 memory / settings 写回 / worktrees（ADR-0019 其余条款），不锚会话记录。**tasks 落点见 ADR-0088**（不再 per-root）。throwaway 隔离目录因此不再自带一份 transcript；同一 `projectIdentityRoot` 共用全局那一格。

存量：把误写在 `<workspace>/.iknow/projects/` 的会话文件夹迁到 `~/.iknow/projects/`；目标已存在的 conversation 叶子不覆盖。

## Why not

**Why not 只给 grep 排除 `.iknow`：** 把日记伪装成搜面问题，并藏掉 worktree / 项目 settings / skills。根因是落点。

**Why not 静默运行时双池 fallback：** 分片是故障；resume 再扫工作区会把故障做成特性。

## Consequences

- (+) 工作区 grep 不再命中会话 jsonl / blobs；TUI 与 `iknow --resume` / trace 读侧同一池。
- (+) ADR-0071 路径字面量与实现同向。
- (−) `--workspace-root` throwaway 不再隔离 transcript；显式 `--data-dir` 仍可另开池。
- (−) 工作区 `.iknow/projects/` 存量需一次性迁走；同 conversation 叶子冲突时保留 home 侧。
