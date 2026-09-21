# 0088. home 项目树：会话记录与后台登记同棵，工作区 `.iknow` 不承载

Date: 2026-09-13
Status: accepted

## Context

工作区 `.iknow/{projects,sessions,tasks}` 是错配：前两者把 harness 日记写进会被 grep 扫到的树，后者把后台登记钉在 checkout（ADR-0021 D1.3），同一 `projectIdentityRoot` 的多份 checkout 各一份账本。ADR-0087 已把会话池根钉到 home，但 tasks 仍 per-root，`sessions/` 退役树仍可能躺在工作区。

## Decision

**home 项目树** = 显式 `--data-dir` 否则 `~/.iknow`，其下 `projects/<slug>/`：会话文件夹叶子 + 同级 `tasks/` + 同级 `memory/`。slug 仍按 `projectIdentityRoot`（ADR-0071）。退役 `sessions/`：产品零写入，不自动迁成会话文件夹（L3）。工作区 `.iknow` 只留必须贴仓的锚（worktrees / 项目 settings / mcp / skills / rules）。冲突叶子不覆盖。不靠 grep 排除整棵 `.iknow`。

## Why not

**Why not tasks 仍跟 `workspaceRoot`：** throwaway checkout 不该另开一份活账本；改绑后「仍看得见任务」要的是项目身份，不是工作区分片。

**Why not 把登记表放进会话文件夹叶子：** 寿命与锁语义跟 conversation 不同（ADR-0071 Decision 2 仍成立）；只换命名空间锚，不换「记录 vs 活状态」。

**Why not 自动把 `sessions/` 收成 `projects/` 叶子：** 扁 jsonl 与会话文件夹形状不同；0071 L3 已否。

## Consequences

- (+) 工作区 grep 不再命中这三类 harness 落盘；多 checkout 共用一份 tasks。
- (−) `--workspace-root` throwaway 不再隔离 tasks（与 0087 对 transcript 同向）；要另池用 `--data-dir`。
- (−) 工作区三目录存量一次性挪走；目标已存在 skip。
