# 0023. serve/Web 工作空间必须显式选定（禁止自动 cwd）

Date: 2026-08-19

Status: accepted

## Context

`iknow serve` 是长驻 host，进程 cwd 通常与用户项目根无关（`build-engine.ts` 已记录）。ADR-0019 D1.1 规定 `workspaceRoot` 默认 = `process.cwd()` —— 这对 `iknow chat` / `tui` / `ask` 等 CLI 对话面仍成立，但对 serve 面会变成「用户尚未在 Web 选择目录，服务器 cwd 就被静默当成项目根」，导致错读/错写。`specs/serve-workspace.md` 因此把 serve 面改为显式主根：未选定即 unbound，选定后三锚合一（`workspaceRoot === cwd === sandboxRoot`）。本 ADR 落盘该决定，作为 ADR-0019 D1.1 仅对 serve 表面的例外，不改 CLI 对话面。

## Decision

serve default = unbound。无 flag/env 的 serve 启动后 hub 不绑定 `workspaceRoot`，必须等 product SPA 选择；禁止 loopback 或任何路径偷偷用 `process.cwd()`。显式预绑仍走 `--workspace-root <abs>` / `IKNOW_WORKSPACE_ROOT`。Recents at `~/.iknow/workspaces.json`，module `src/config/workspaces-recents.ts`。

四条锁定裁决：

1. 无 flag/env 的 serve → 必须等 SPA 选择（禁止 loopback 偷偷用 cwd）。
2. 换根 → 只开新会话（不 PATCH 旧会话根）。
3. 新绝对路径 → 确认信任；recents 已信任。
4. v1 = 单根 + recents + 三锚合一；worktree/多根只读推迟。

EXIT: unbound `postMessage` 400 validation field `workspaceRoot`；`WorkspaceRootError` 400 validation field `path` before store `not_found`。

## Consequences

### Positive

- Web 项目锚显式化：serve 缺省不再静默使用进程 cwd，杜绝无选择下的错读/错写。
- 绑定后三锚合一（`workspaceRoot === cwd === sandboxRoot`）；旧 session 缺 `workspaceRoot` 字段视为 unbound，不回填 cwd。
- recents/trust 落在 `home`（`~/.iknow/workspaces.json`），与 per-root 状态锚分离。

### Negative / Trade-offs

- serve 无 flag/env 时开箱可用性下降：必须先经 SPA 选根或显式 flag/env 预绑。
- 这是 ADR-0019 D1.1 的表面例外；chat/tui/ask 的 cwd 默认不变，两条锚语义并行。
- 错误契约必须区分字段：unbound 报 `workspaceRoot`，路径不存在报 `path`，且 `path` 映射先于 store `not_found`。
