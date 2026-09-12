# G1 裸 git worktree add 要不要变成 rebind

- Map: [主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）](../agent-control-surface-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-11，操作员裁 B 变体)
- Blocked by: R1（已结）

## Question

isolation OFF 时模型用 bash `git worktree add` 建树成功，但会话不 enter。到达 destination 时，我们要哪一条：

- A：保持 ADR-0037——只有 `create-worktree` 才 rebind；OFF 时裸 git 建树是「磁盘副作用，不是产品树」。
- B：OFF 也装配 create/enter，说明书要求用工具而不是 bash git。
- C：检测 bash 建树成功后硬闸提示 / 自动 enter（挑战「门禁从不 auto-provision」）。

本票不写代码。

## Resolution

操作员裁：**保留 `create-worktree`（工作树工具族）不跟隔离开关捆死**；开关 ON 的唯一产品差别是「想写/改文件会被门禁拦，须进树再写」。这是对 ADR-0037「工具在场 ⇔ 门禁已武装」的挑战，落地须另开 spec/改装配，本票只记账。

配置现势：用户全局 `~/.iknow/settings.json` 已是 `worktreeOnMutate: true`。本仓项目 `.iknow/settings.json` 已去掉 isolation 覆盖（2026-09-11），合并后跟全局 ON。重启 TUI 才读到（开关只在启动加载点读一次）。
