# R1 isolation OFF 时工作树工具是否在场

- Map: [主代理控制面（建树 / todo / 子代理 / 打断 / 读会话）](../agent-control-surface-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved (charting research, 2026-09-11)
- Blocked by: —

## Resolution

`worktreeOnMutate === false` ⇒ `isolationEnabled` false ⇒ 不透传 `worktreeProvision` / enter / list。主会话注册表 **没有** `create-worktree`、`enter-worktree`、`list-worktrees`。裸 `git worktree add` **不** rebind、**无**「下一波 cwd 已切」回执；`liveTaskRoot` 只经 ACI provision/enter/exit 写入。证据：`src/harness/build-engine.ts:628-629,1033-1055`；`src/harness/aci/tools/registry.ts:737-797,827-834`；`tests/session-api/hub-worktree-isolation.test.ts:1327-1332`。

## Question

当 `settings.isolation.worktreeOnMutate === false` 时，主会话 ACI 注册表是否包含 `create-worktree` / `enter-worktree` / `list-worktrees`？`worktreeProvision` 缝是否因 isolationEnabled 缺席？模型用 `git worktree add` 成功后，有没有任何自动 rebind 或「下一波 cwd 已切」的回执？

需要文件:行证据，不要只复述 ADR 散文。
