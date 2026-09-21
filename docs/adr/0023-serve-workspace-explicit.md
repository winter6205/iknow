# 0023. serve/Web workspace must be explicitly selected (no automatic cwd)

Date: 2026-08-19

Status: accepted

> Reopened and aligned on 2026-08-29. This revision supersedes the original
> serve-only wording that treated an unbound hub as the normal default; it does
> not supersede ADR-0019's per-root resolver defaults outside session binding.

## Context

`iknow serve` is a long-lived host whose process cwd is usually unrelated to the user's project root (already noted in `build-engine.ts`). ADR-0019 D1.1 sets the `workspaceRoot` default = `process.cwd()`; that remains the resolution-layer default for entry points like `iknow chat` / `tui` / `ask`, but a session must never lack an explicit binding at creation time. ADR-0023 originally recorded only the surface exception that serve should not silently use cwd; this reopening aligns the constraint to all session-backed entry points and pins serve's stable default binding.
The earlier phrasing "serve defaults to unbound" no longer matches the current implementation: started without flag/env, serve writes `<homedir>/.iknow/default` into new sessions as an **explicit default binding**, rather than treating unbound as the product default. With further alignment, every new session from `cli chat`, `tui`, and `serve` must obtain and validate a `workspaceRoot` at creation; the resolved `process.cwd()` or `~/.iknow/default` must also be passed in as an explicit binding value.

## Decision

Every new session must bind a validated `workspaceRoot` at creation; creating a rootless session file is forbidden, and silently filling in `process.cwd()` is forbidden. `cli chat`, `tui`, and `serve` all follow the same binding contract.

`iknow serve` without flag/env explicitly binds `<homedir>/.iknow/default`, so this is a default bind, not unbound; `--workspace-root <abs>` / `IKNOW_WORKSPACE_ROOT` still provide explicit pre-binding. No unbound path may quietly use `process.cwd()`. Recents at `~/.iknow/workspaces.json`, module `src/config/workspaces-recents.ts`.

unbound denotes only a transitional or legacy-invalid state with no validatable binding; it is not a normal product state. Execute on a current session is rejected before the engine runs with a typed validation failure; a legacy session with a missing or invalid `workspaceRoot` may be marked archived/invalid at load/list but must not execute — the user must recreate or bind, and no cwd back-fill is allowed.

Four locked rulings:

1. serve without flag/env → explicitly bind `<homedir>/.iknow/default` (calling this default binding "unbound" is forbidden, as is loopback quietly using cwd).
2. Changing root → open a new session only (never PATCH an old session's root).
3. New absolute path → confirm trust; recents are already trusted.
4. v1 = single root + recents + three anchors unified; worktree/multi-root read-only deferred. The session worktree returned by Harness isolation belongs to session-level isolation and rebind and does not change the product workspace's single-root binding rule.

EXIT: unbound `postMessage` 400 validation field `workspaceRoot`; `WorkspaceRootError` 400 validation field `path` before store `not_found`.

## Consequences

### Positive

- The project anchor is explicit: serve defaults to the clear `~/.iknow/default` binding or a user-specified root, never silently treating a long-lived process's cwd as the project root.
- After binding, the three anchors unify (`workspaceRoot === cwd === sandboxRoot`); an old session missing the `workspaceRoot` field is treated as legacy archived/invalid, with no cwd back-fill.
- recents/trust live in `home` (`~/.iknow/workspaces.json`), separated from the per-root state anchor.

### Negative / Trade-offs

- Without flag/env, serve uses `~/.iknow/default` as its stable default root; users wanting another root must go through SPA root selection or an explicit flag/env pre-bind.
- ADR-0019 D1.1's resolver default and session-creation binding are two layers: chat/tui/ask may resolve cwd, but must bind the resolved value as an explicit root when creating the session.
- The error contract must distinguish fields: unbound reports the `workspaceRoot` field, missing/invalid path reports `path`, and the `path` mapping precedes the store's `not_found`.
