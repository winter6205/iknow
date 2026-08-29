# 0023. serve/Web 工作空间必须显式选定（禁止自动 cwd）

Date: 2026-08-19

Status: accepted

> Reopened and aligned on 2026-08-29. This revision supersedes the original
> serve-only wording that treated an unbound hub as the normal default; it does
> not supersede ADR-0019's per-root resolver defaults outside session binding.

## Context

`iknow serve` 是长驻 host，进程 cwd 通常与用户项目根无关（`build-engine.ts` 已记录）。ADR-0019 D1.1 规定 `workspaceRoot` 默认 = `process.cwd()`；这对 `iknow chat` / `tui` / `ask` 等入口仍是解析层默认，但不能让 session 在创建时缺少显式绑定。ADR-0023 原先只记录 serve 不应静默使用 cwd 的表面例外；本次重开把该约束对齐到所有 session-backed 入口，并明确 serve 的稳定默认绑定。
此前“serve 缺省 unbound”的表述已不再符合当前实现：无 flag/env 启动时，serve 会把 `<homedir>/.iknow/default` 作为**显式默认绑定**写入新会话，而不是把 unbound 当作产品默认状态。进一步对齐后，`cli chat`、`tui`、`serve` 的每个新会话都必须在创建时取得并校验 `workspaceRoot`；解析出的 `process.cwd()` 或 `~/.iknow/default` 也必须作为明确的绑定值传入。

## Decision

每个新 session 在创建时必须绑定经过校验的 `workspaceRoot`；禁止创建 rootless session file，也禁止以 `process.cwd()` 作为隐式补写。`cli chat`、`tui`、`serve` 都遵循同一条绑定契约。

`iknow serve` 无 flag/env 时显式绑定 `<homedir>/.iknow/default`，因此这是 default bind 而不是 unbound；`--workspace-root <abs>` / `IKNOW_WORKSPACE_ROOT` 仍提供显式预绑。禁止任何未绑定路径偷偷使用 `process.cwd()`。Recents at `~/.iknow/workspaces.json`，module `src/config/workspaces-recents.ts`。

unbound 仅表示没有可校验绑定的过渡或遗留无效状态，不是正常产品状态。当前 session 的 execute 在 engine 运行前以 typed validation failure 拒绝；缺少或非法 `workspaceRoot` 的 legacy session 可在 load/list 中标为 archived/invalid，但不得执行，用户必须 recreate 或 bind，且不得回填 cwd。

四条锁定裁决：

1. 无 flag/env 的 serve → 显式绑定 `<homedir>/.iknow/default`（禁止把该默认绑定称为 unbound，也禁止 loopback 偷偷用 cwd）。
2. 换根 → 只开新会话（不 PATCH 旧会话根）。
3. 新绝对路径 → 确认信任；recents 已信任。
4. v1 = 单根 + recents + 三锚合一；worktree/多根只读推迟。Harness isolation 返回的 session worktree 属于会话级隔离与 rebind，不改变 product workspace 的单根绑定规则。

EXIT: unbound `postMessage` 400 validation field `workspaceRoot`；`WorkspaceRootError` 400 validation field `path` before store `not_found`。

## Consequences

### Positive

- 项目锚显式化：serve 默认使用明确的 `~/.iknow/default` 绑定或用户指定根，不静默把长驻进程 cwd 当成项目根。
- 绑定后三锚合一（`workspaceRoot === cwd === sandboxRoot`）；旧 session 缺 `workspaceRoot` 字段视为 legacy archived/invalid，不回填 cwd。
- recents/trust 落在 `home`（`~/.iknow/workspaces.json`），与 per-root 状态锚分离。

### Negative / Trade-offs

- serve 无 flag/env 时以 `~/.iknow/default` 作为稳定默认根；用户要使用其他根仍须经 SPA 选根或显式 flag/env 预绑。
- ADR-0019 D1.1 的 resolver 默认与 session 创建绑定是两个层次：chat/tui/ask 可解析 cwd，但必须在创建 session 时把解析值作为明确 root 绑定。
- 错误契约必须区分字段：unbound 报 `workspaceRoot`，路径不存在报 `path`，且 `path` 映射先于 store `not_found`。
